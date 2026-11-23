import { symbols, type Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubagentCapacityPool, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { LiveConfig } from './config.js'
import { isAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { StepReviewSettings } from './types.js'
import { failureDetails, ReviewError } from './failure.js'
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
  private readonly capacityConfigs = new Set<LiveConfig>()
  private capacityPool: SubagentCapacityPool | undefined
  private capacityRuntime: SubagentRuntime | undefined
  private readonly off: (() => void)[]
  private presetReady?: Promise<void>
  private unregisterPreset?: () => Promise<void>
  private readonly pendingEvidence = new WeakMap<ToolExecution, ReviewEvidence[]>()

  constructor(root: Context) {
    this.off = [
      root.on('agent/pre-step', async (payload, next) => {
        const run = this.runs.get(payload.agent.id)
        if (run) {
          this.check(run)
          run.steps.add(payload.turn + '/' + payload.step)
          if (run.steps.size > run.maxSteps) this.fail(run, '审查 Agent 已达到步骤上限（' + run.maxSteps + '）')
        }
        return next()
      }, { global: true, prepend: true }),
      root.on('llm/stream', (request, next) => {
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
                run.failure = new ReviewError('审查模型调用失败 · ' + failureDetails(chunk.reason.failure))
              } else if (chunk.reason.kind === 'max-tokens') {
                run.failure = new ReviewError('审查模型达到原生模型响应上限，请检查模型设置或推理等级')
              }
            }
            yield chunk
          }
          coordinator.check(run)
        })()
      }, { global: true, prepend: true }),
      root.on('agent/request-error', async (payload, next) => {
        const run = this.runs.get(payload.agent.id)
        if (run) run.failure = new ReviewError('审查模型调用失败 · ' + failureDetails(payload.failure))
        return next()
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
  }

  retain(ctx: Context, config: LiveConfig): void {
    this.capacityConfigs.add(config)
    this.users++
    ctx.effect(() => async () => {
      this.capacityConfigs.delete(config)
      if (--this.users > 0) return
      // 先取消全部审查；原生 activation 的收尾由各派发者等待。
      for (const run of this.runs.values()) run.controller.abort(new ReviewError('审查插件已卸载'))
      await Promise.all([...this.runs.values()].map(run => run.closed))
      await this.presetReady?.catch(() => undefined)
      await this.unregisterPreset?.()
      for (const off of this.off) off()
      coordinators.delete(ctx.root)
    })
  }

  reviewPool(ctx: Context): SubagentCapacityPool {
    if (typeof ctx.subagents.createCapacityPool !== 'function') {
      throw new ReviewError('独立审查容量池需要升级宿主并重启服务，请应用配套容量池补丁')
    }
    const runtime = ctx.subagents
    const identity = (Reflect.get(runtime, symbols.original) ?? runtime) as SubagentRuntime
    if (this.capacityRuntime === identity && this.capacityPool !== undefined) return this.capacityPool
    this.capacityRuntime = identity
    return this.capacityPool = runtime.createCapacityPool(() => {
      // 同宿主多处挂载共享一个池，采用各有效配置中的最小容量。
      const limits = [...this.capacityConfigs].map(config => config.maxConcurrentReviews.get())
      if (limits.length === 0) throw new ReviewError('审查插件已卸载')
      return Math.min(...limits)
    })
  }

  ensurePreset(ctx: Context): Promise<void> {
    return this.presetReady ??= (async () => {
      this.unregisterPreset = await ctx.root.agentPresets.register(reviewerPresetDefinition)
    })()
  }

  finish(id: string): void {
    const run = this.runs.get(id)
    this.runs.delete(id)
    run?.close()
  }

  register(id: string, settings: StepReviewSettings, controller: AbortController): ReviewRun {
    if (this.runs.has(id)) throw new ReviewError('审查子会话身份重复')
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    const run: ReviewRun = { closed, close, controller, expiresAt: performance.now() + settings.timeoutMs,
      maxSteps: settings.maxReviewSteps,
      steps: new Set(), evidence: new Map() }
    this.runs.set(id, run)
    return run
  }

  check(run: ReviewRun): void {
    if (run.error) throw run.error
    if (performance.now() >= run.expiresAt) this.fail(run, '审查 Agent 超过总期限')
    if (run.controller.signal.aborted) throw new ReviewError('审查 Agent 已取消')
  }

  fail(run: ReviewRun, message: string): never {
    run.error = new ReviewError(message)
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
    const target = await entry.fs.resolve(entry.target.displayPath, { signal })
    if (target.targetKey !== entry.target.targetKey) {
      throw new ReviewError('审查取证文件的引用目标已变化，请重新审查：' + entry.target.displayPath)
    }
    const current = await entry.fs.stat(target, signal)
    if (entry.observation.kind === 'absent' ? current !== undefined : current?.version !== entry.observation.version) {
      throw new ReviewError('审查取证文件已变化或消失，请重新生成候选后审查：' + entry.target.displayPath)
    }
  }
}
