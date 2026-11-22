import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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
  maxBytes: number
  bytes: number
  materialChars: number
  reservedMaterialChars: number
  maxMaterialChars: number
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
  private readonly off: (() => void)[]
  private presetReady?: Promise<void>
  private unregisterPreset?: () => Promise<void>
  private readonly materialReservations = new WeakMap<ToolExecution, number>()
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
        const run = request.sessionId === undefined ? undefined : this.runs.get(request.sessionId)
        if (!run) return next()
        const coordinator = this
        return (async function* (): AsyncGenerator<StreamChunk> {
          coordinator.check(run)
          for await (const chunk of next()) {
            coordinator.check(run)
            run.bytes += Buffer.byteLength(JSON.stringify(chunk))
            if (run.bytes > run.maxBytes) coordinator.fail(run, '审查 Agent 响应累计超过字节上限')
            if (chunk.type === 'finish') {
              if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                run.failure = new ReviewError('审查模型调用失败 · ' + failureDetails(chunk.reason.failure))
              } else if (chunk.reason.kind === 'max-tokens') {
                run.failure = new ReviewError('审查模型达到每次响应的 token 上限，请调整输出上限或推理等级')
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
      root.on('tools/post-execute', async (exec, result, next) => {
        const run = exec.agent ? this.runs.get(exec.agent.id) : undefined
        if (!run) return next()
        this.check(run)
        // 外层等下游完成改写，按最终获准投影预留；同批调用不能重复占用剩余额度。
        const decision = await next()
        this.check(run)
        if (exec.name === 'structured_output' || result.isError || decision.kind === 'block') return decision
        const tool = root.get('tools')?.executable(exec.name, exec.agent, exec.toolSet)
        // 自定义工具若会在 post 之后改写正文，此处无法预知其大小，须在暴露材料前拒绝。
        if (!tool || tool.finalizeContent) {
          return { kind: 'block', feedback: [{ type: 'text', text:
            '此取证工具的最终输出无法在材料预算检查时确定，结果未提供。请改用可预算的 read/grep/glob 聚焦取证；无法取得必要证据时提交 structured_output reject，说明证据缺口并给出订正建议。' }] }
        }
        const content = Object.hasOwn(decision, 'value')
          ? tool.output.render(exec.arguments, decision.value!)
          : decision.content ?? result.content
        const chars = JSON.stringify(content).length
        const remaining = Math.max(0, run.maxMaterialChars - run.materialChars - run.reservedMaterialChars)
        if (chars > remaining) {
          return { kind: 'block', feedback: [{ type: 'text', text:
            '本次取证结果需要 ' + chars + ' 个材料字符，剩余预算 ' + remaining + ' / ' + run.maxMaterialChars + '，结果未提供。'
            + '请缩小 read 的 offset/limit 窗口，或用更具体的 grep/glob 聚焦文件与关键词，避免重复读取。'
            + '错误反馈和 structured_output 不消耗材料预算；若剩余预算不足以取得必要证据，请提交 structured_output reject，说明缺失证据并给出局部订正建议，不能猜测 pass。' }] }
        }
        this.materialReservations.set(exec, chars)
        run.reservedMaterialChars += chars
        return decision
      }, { global: true, prepend: true }),
      root.on('tools/result', (exec, result) => {
        const run = exec.agent ? this.runs.get(exec.agent.id) : undefined
        if (!run) return undefined
        const reserved = this.materialReservations.get(exec) ?? 0
        this.materialReservations.delete(exec)
        run.reservedMaterialChars -= reserved
        const evidence = this.pendingEvidence.get(exec) ?? []
        this.pendingEvidence.delete(exec)
        // 同一个原生执行对象在 post/result 间保持身份；取消、校验失败等终态只释放预留和观察。
        if (!result.isError && exec.name !== 'structured_output') {
          run.materialChars += JSON.stringify(result.content).length
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
          // 原生 read 在 body 阶段报告观察；正文预算拦截或工具失败时不得覆盖已接受证据。
          const evidence = this.pendingEvidence.get(exec!) ?? []
          evidence.push({ fs, target: { ...target }, observation: { ...observation } })
          this.pendingEvidence.set(exec!, evidence)
        }
      }),
    ]
  }

  retain(ctx: Context): void {
    this.users++
    ctx.effect(() => async () => {
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

  register(id: string, settings: StepReviewSettings, controller: AbortController, materialChars = 0): ReviewRun {
    if (this.runs.has(id)) throw new ReviewError('审查子会话身份重复')
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    const run: ReviewRun = { closed, close, controller, expiresAt: performance.now() + settings.timeoutMs,
      maxSteps: settings.maxReviewSteps, maxBytes: Math.max(262144, 128 * settings.maxReviewTokens), bytes: 0, materialChars, reservedMaterialChars: 0, maxMaterialChars: settings.maxReviewChars,
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
