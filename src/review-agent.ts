/** 使用公开 Agent 工厂创建独立审查，不占用原生子 Agent 目录或工作容量。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides, resolveChildAgentOptions, resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createReviewRuntime } from './review-runtime.js'
import { abortable, cleanup } from './review-async.js'
import type { ReviewCoordinator } from './review-coordinator.js'
import { failureDetails, ReviewError, safeErrorMessage } from './failure.js'
import { attachReviewResult, type ReviewResult } from './review-result.js'

export interface ReviewAgent {
  dispose(): Promise<void>
  events(): readonly SessionEvent[]
  result: ReviewResult
  run(prompt: string): Promise<void>
}

export async function createReviewAgent(ctx: Context, parent: Agent, childId: SessionId, agentPreset: string, requested: AgentOptions, coordinator: ReviewCoordinator, signal: AbortSignal): Promise<ReviewAgent> {
  signal.throwIfAborted()
  // 与原生委派一致，权限和模型选项在首个 await 前捕获，后续主会话切换不影响本次审查。
  const policies = captureDelegatedPolicyOverrides(parent)
  const depth = resolveChildDepth(parent, undefined)
  const agentOptions = resolveChildAgentOptions(parent, requested, depth)
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new ReviewError('审查 Agent 需要工作目录服务', { code: 'STEP_REVIEW_WORKING_DIRECTORY_MISSING', stage: 'startup' })
  const cwd = await abortable(workingDirectory.ensure(parent, signal), signal).catch(error => {
    if (signal.aborted && error === signal.reason) throw error
    throw new ReviewError('确认主会话工作目录失败 · ' + safeErrorMessage(error), { code: 'STEP_REVIEW_WORKING_DIRECTORY_FAILED', stage: 'startup', cause: error })
  })
  signal.throwIfAborted()
  if (ctx.agents.get(parent.id) !== parent) throw new ReviewError('所属主 Agent 已变化，请重新发起审查', { code: 'STEP_REVIEW_PARENT_CHANGED', stage: 'startup' })

  const runtime = await createReviewRuntime(parent, cwd, agentPreset, coordinator, signal)
  const hostAgents = parent.ctx.agents
  try {
    return await hostAgents.withoutInitiator(async () => {
      let result!: ReviewResult
      let completed = false
      let liveFailure: ReviewError | undefined
      const creation = runtime.agents.create({
        sessionId: childId,
        // 新会话不传 seed、parentSession、origin 或原生 descriptor，审查历史由插件关联。
        meta: { cwd, agentPreset, delegationDepth: depth },
        agentOptions,
        signal,
        async setup(childCtx, child) {
          await abortable(Promise.resolve(applyChildComposition(childCtx, parent, { agentPreset })), signal)
          signal.throwIfAborted()
          child.session.append('agent-preset/selected', { agentPreset })
          appendDelegatedPolicyOverrides(child.session, policies)
          const childDirectory = childCtx.get('workingDirectory')
          if (childDirectory === undefined) throw new ReviewError('审查 preset 缺少工作目录服务', { code: 'STEP_REVIEW_PRESET_DIRECTORY_MISSING', stage: 'startup' })
          await abortable(childDirectory.set(child, cwd, signal), signal)
          signal.throwIfAborted()
          result = attachReviewResult(childCtx, signal, () => child.inbox.nextStep.length === 0 && child.inbox.nextTurn.length === 0)
          childCtx.on('agent/error', ({ agent, error }) => {
            if (agent === child) liveFailure = new ReviewError('审查 Agent 执行失败 · ' + safeErrorMessage(error), { code: 'STEP_REVIEW_AGENT_FAILED', stage: 'run', cause: error })
          })
          childCtx.on('session/event', (session, event) => {
            if (session !== child.session) return
            if (event.type === 'turn/start') {
              completed = false
              liveFailure = undefined
            } else if (event.type === 'turn/end') {
              const reason = event.data.reason
              completed = reason.kind === 'completed'
              if (completed) liveFailure = undefined
              else if (reason.kind === 'error' && reason.error.code !== 'UNKNOWN') {
                liveFailure = new ReviewError('审查 Agent 执行失败 · ' + failureDetails(reason.error), { code: reason.error.code, stage: 'run' })
              }
            } else if (event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled' && event.data.inserted.length === 0) {
              completed = false
            }
          })
        },
      })
      let handle: Awaited<typeof creation>
      try { handle = await abortable(creation, signal) } catch (error) {
        cleanup(() => creation.then(late => late.dispose()), cause => ctx.logger.warn('晚到审查 Agent 清理失败 · ' + safeErrorMessage(cause)))
        throw error
      }
      let disposing: Promise<void> | undefined
      return {
        result,
        events: () => handle.agent.session.snapshotEvents(),
        dispose() {
          return disposing ??= Promise.all([
            Promise.resolve().then(() => handle.dispose()),
            Promise.resolve().then(() => runtime.fiber.dispose()),
          ]).then(() => undefined)
        },
        run: prompt => hostAgents.withoutInitiator(async () => {
          signal.throwIfAborted()
          const cancel = () => handle.agent.cancel({ kind: 'parent' })
          signal.addEventListener('abort', cancel, { once: true })
          try {
            handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
            await abortable(handle.agent.whenIdle(), signal)
          } finally {
            signal.removeEventListener('abort', cancel)
          }
          signal.throwIfAborted()
          if (liveFailure) throw liveFailure
          if (!completed || handle.agent.inbox.nextStep.length > 0 || handle.agent.inbox.nextTurn.length > 0) {
            throw new ReviewError('审查 Agent 未正常完成，请检查审查详情', { code: 'STEP_REVIEW_INCOMPLETE', stage: 'run' })
          }
        }),
      }
    })
  } catch (error) {
    cleanup(() => runtime.fiber.dispose(), cause => ctx.logger.warn('审查 Agent 创建失败后的资源清理异常 · ' + safeErrorMessage(cause)))
    if (signal.aborted && error === signal.reason) throw error
    throw new ReviewError('创建审查 Agent 失败 · ' + safeErrorMessage(error), { code: 'STEP_REVIEW_AGENT_CREATE_FAILED', stage: 'startup', cause: error })
  }
}
