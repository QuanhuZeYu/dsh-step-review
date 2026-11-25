import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { LiveConfig } from './config.js'
import { isAgentLoopRequest, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import { abortable } from './review-async.js'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { StepReviewSettings } from './types.js'
import { failureDetails, isTransientFailure, ReviewError } from './failure.js'
import { reviewerPresetDefinition } from './reviewer-preset.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export interface ReviewEvidence {
  fs: FileSystem
  target: FsTarget
  observation: FsObservation
}
export interface ReviewRun {
  controller: AbortController
  expiresAt: number
  maxSteps: number
  steps: Set<string>
  retryAttempts: Map<string, number>
  evidence: Map<string, ReviewEvidence>
  error?: ReviewError
  failure?: ReviewError
  closed: Promise<void>
  close(): void
}

/** 同一宿主的插件实例共用登记，子 Agent 首个请求也能被识别。 */
const coordinators = new WeakMap<object, ReviewCoordinator>()
export class ReviewCoordinator {
  readonly runs = new Map<string, ReviewRun>()
  private users = 0
  private generation = 0
  private readonly claimedRequests = new WeakSet<object>()
  private readonly waiters: { signal: AbortSignal; grant(release: () => void): void; reject(error: unknown): void; abort(): void }[] = []
  private presetTeardown?: Promise<void>
  private readonly capacityConfigs = new Map<LiveConfig, number>()
  private readonly reviewSlots = new Set<symbol>()
  private presetReady?: Promise<void>
  private unregisterPreset?: () => Promise<void>
  private readonly pendingEvidence = new WeakMap<ToolExecution, ReviewEvidence[]>()

  constructor(_root: Context) {}

  attach(root: Context): void {
    const off = [
      root.on('agent/pre-step', async (payload, next) => {
        const run = this.runs.get(payload.agent.id)
        if (run) {
          this.check(run)
          run.steps.add(payload.turn + '/' + payload.step)
          if (run.steps.size > run.maxSteps) this.fail(run, '审查 Agent 已达到步骤上限（' + run.maxSteps + '）', 'STEP_REVIEW_STEP_LIMIT')
        }
        return next()
      }, { global: true, prepend: true }),
      root.on('agent/request-error', async (payload, next) => {
        const run = this.runs.get(payload.agent.id)
        if (!run) return next()
        const signal = AbortSignal.any([payload.signal, run.controller.signal])
        signal.throwIfAborted()
        this.check(run)
        run.failure = new ReviewError('审查模型调用失败 · ' + failureDetails(payload.failure), {
          code: payload.failure.code, stage: 'request', cause: LlmError.fromFailure(payload.failure),
          retryable: isTransientFailure(payload.failure),
        })
        const key = payload.turn + '/' + payload.step
        const attempt = run.retryAttempts.get(key) ?? 0
        if (!isTransientFailure(payload.failure) || attempt >= 2) return undefined
        run.retryAttempts.set(key, attempt + 1)
        await delay(attempt === 0 ? 200 : 400, undefined, { signal })
        signal.throwIfAborted()
        this.check(run)
        return { kind: 'retry' }
      }, { global: true, prepend: true }),
      root.on('tools/result', (exec, result) => {
        const run = exec.agent ? this.runs.get(exec.agent.id) : undefined
        if (!run) return undefined
        const evidence = this.pendingEvidence.get(exec) ?? []
        this.pendingEvidence.delete(exec)
        // 仅成功提供给模型的结果纳入证据；工具失败或原生拦截时释放暂存观察。
        if (!result.isError && exec.name !== 'structured_output') {
          // 不同已见版本均保留，避免模型混用旧正文与新版本时通过最终复核。
          for (const entry of evidence) {
            run.evidence.set(JSON.stringify([entry.target.targetKey, entry.target.displayPath, entry.observation]), entry)
          }
        }
        return undefined
      }, { global: true }),
      root.on('fs/observed', (target, observation, actor) => {
        const exec = actor as ToolExecution | undefined
        const agent = exec?.agent
        if (!agent) return
        const run = this.runs.get(agent.id)
        const fs = agent.ctx.get('fs')
        if (run && fs) {
          // 原生 read 在 body 阶段报告观察；工具失败时不得覆盖已接受证据。
          const evidence = this.pendingEvidence.get(exec!) ?? []
          evidence.push({ fs, target: { ...target }, observation: { ...observation } })
          this.pendingEvidence.set(exec!, evidence)
        }
      }),
    ]
    root.effect(() => () => { for (const dispose of off) dispose() })
  }

  observeStream(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    // 标题等辅助请求共享会话 ID，其错误不属于审查正文。
    if (!isAgentLoopRequest(request)) return next()
    const run = request.sessionId === undefined ? undefined : this.runs.get(request.sessionId)
    if (!run) return next()
    const coordinator = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      coordinator.check(run)
      for await (const chunk of next()) {
        coordinator.check(run)
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            run.failure = new ReviewError('审查模型调用失败 · ' + failureDetails(chunk.reason.failure), {
              code: chunk.reason.failure.code, stage: 'request', cause: LlmError.fromFailure(chunk.reason.failure),
            })
          } else if (chunk.reason.kind === 'max-tokens') {
            run.failure = new ReviewError('审查模型达到原生模型响应上限，请检查模型设置或推理等级', { code: 'STEP_REVIEW_MAX_TOKENS', stage: 'request' })
          } else {
            run.failure = undefined
            run.retryAttempts.clear()
          }
        }
        yield chunk
      }
      coordinator.check(run)
    })()
  }

  claimRequest(request: GenerateOptions): boolean {
    if (this.claimedRequests.has(request)) return false
    this.claimedRequests.add(request)
    return true
  }

  retain(ctx: Context, config: LiveConfig): void {
    this.capacityConfigs.set(config, (this.capacityConfigs.get(config) ?? 0) + 1)
    this.users++
    this.generation++
    this.drain()
    ctx.effect(() => async () => {
      const references = this.capacityConfigs.get(config) ?? 0
      if (references > 1) this.capacityConfigs.set(config, references - 1)
      else this.capacityConfigs.delete(config)
      if (--this.users > 0) { this.drain(); return }
      const generation = ++this.generation
      const unloaded = new ReviewError('审查插件已卸载', { code: 'STEP_REVIEW_UNLOADED', stage: 'lifecycle' })
      for (const waiter of this.waiters.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.abort)
        waiter.reject(unloaded)
      }
      for (const run of this.runs.values()) run.controller.abort(unloaded)
      await Promise.all([...this.runs.values()].map(run => run.closed))
      if (this.users > 0 || generation !== this.generation) return
      await this.presetReady?.catch(() => undefined)
      if (this.users > 0 || generation !== this.generation) return
      // 注销开始后，新 retain 的 ensurePreset 必须等待本次注销，不能复用旧 ready。
      const unregister = this.unregisterPreset
      this.unregisterPreset = undefined
      this.presetReady = undefined
      const teardown = Promise.resolve().then(() => unregister?.())
      this.presetTeardown = teardown
      try { await teardown } finally {
        if (this.presetTeardown === teardown) this.presetTeardown = undefined
        if (this.users === 0 && generation === this.generation && coordinators.get(ctx.root) === this) coordinators.delete(ctx.root)
      }
    })
  }

  /** 容量满时先进先出等待；释放幂等，等待期间取消会立即移出队列。 */
  reserve(_ctx: Context, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.users === 0) return Promise.reject(new ReviewError('审查插件已卸载', { code: 'STEP_REVIEW_UNLOADED', stage: 'capacity' }))
    return new Promise((resolve, reject) => {
      const waiter = { signal, grant: resolve, reject, abort: () => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        reject(signal.reason)
        this.drain()
      } }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.drain()
    })
  }

  private drain(): void {
    if (this.users === 0) return
    const limits = [...this.capacityConfigs.keys()].map(config => config.maxConcurrentReviews.get())
    const capacity = Math.min(...limits)
    while (this.waiters.length > 0 && this.reviewSlots.size < capacity) {
      const waiter = this.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue }
      const slot = Symbol('review')
      this.reviewSlots.add(slot)
      let released = false
      waiter.grant(() => {
        if (released) return
        released = true
        this.reviewSlots.delete(slot)
        this.drain()
      })
    }
  }

  ensurePreset(ctx: Context): Promise<void> {
    return this.presetReady ??= (async () => {
      await this.presetTeardown
      this.unregisterPreset = await ctx.root.agentPresets.register(reviewerPresetDefinition)
    })()
  }

  finish(id: string): void {
    const run = this.runs.get(id)
    this.runs.delete(id)
    run?.close()
  }

  register(id: string, settings: StepReviewSettings, controller: AbortController): ReviewRun {
    if (this.runs.has(id)) throw new ReviewError('审查任务身份重复', { code: 'STEP_REVIEW_DUPLICATE_RUN', stage: 'lifecycle' })
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    const run: ReviewRun = { closed, close, controller, expiresAt: performance.now() + settings.timeoutMs,
      maxSteps: settings.maxReviewSteps,
      steps: new Set(), retryAttempts: new Map(), evidence: new Map() }
    this.runs.set(id, run)
    return run
  }

  check(run: ReviewRun): void {
    if (run.error) throw run.error
    if (performance.now() >= run.expiresAt) this.fail(run, '审查 Agent 超过总期限', 'STEP_REVIEW_TIMEOUT')
    if (run.controller.signal.aborted) {
      const cause = run.controller.signal.reason
      if (cause instanceof ReviewError) throw cause
      throw new ReviewError('审查 Agent 已取消', { code: 'STEP_REVIEW_ABORTED', stage: 'lifecycle', cause })
    }
  }

  fail(run: ReviewRun, message: string, code: string): never {
    run.error = new ReviewError(message, { code, stage: 'lifecycle' })
    run.controller.abort(run.error)
    throw run.error
  }
}

export function reviewCoordinator(ctx: Context): ReviewCoordinator {
  let value = coordinators.get(ctx.root)
  if (!value) { value = new ReviewCoordinator(ctx.root); coordinators.set(ctx.root, value) }
  return value
}

/** 原生版本是不可解释的令牌，仅比较，不从中推断本地路径或时间。 */
export async function verifyEvidence(evidence: readonly ReviewEvidence[], signal: AbortSignal): Promise<void> {
  for (const entry of evidence) {
    signal.throwIfAborted()
    const target = await abortable(entry.fs.resolve(entry.target.displayPath, { signal }), signal)
    if (target.targetKey !== entry.target.targetKey) {
      throw new ReviewError('审查取证文件的引用目标已变化，请重新审查：' + entry.target.displayPath, { code: 'STEP_REVIEW_EVIDENCE_TARGET_CHANGED', stage: 'evidence' })
    }
    const current = await abortable(entry.fs.stat(target, signal), signal)
    if (entry.observation.kind === 'absent' ? current !== undefined : current?.version !== entry.observation.version) {
      throw new ReviewError('审查取证文件已变化或消失，请重新生成候选后审查：' + entry.target.displayPath, { code: 'STEP_REVIEW_EVIDENCE_CHANGED', stage: 'evidence' })
    }
  }
}