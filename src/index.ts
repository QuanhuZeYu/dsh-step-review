/** 完整响应关口：通过后原样释放，拒绝后把反馈写入原会话并有界订正。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, snapshot } from './config.js'
import type { LiveConfig } from './config.js'
import { matchRules } from './matcher.js'
import { reviewCandidate } from './reviewer.js'
import { registerReviewCatalog } from './review-catalog.js'
import { reviewCoordinator, verifyEvidence, type ReviewEvidence } from './review-coordinator.js'
import './reviewer-preset.js'
import { ReviewError, safeErrorMessage } from './failure.js'
import type { Candidate, RuleVerdict, ReviewRecord } from './types.js'

export { Config }
export const name = 'step-review'
export const inject = ['llm', 'agents', 'subagents', 'agentPresets']
const REJECTED = 'STEP_REVIEW_REJECTED'
const FAILED = 'STEP_REVIEW_FAILED'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'step-review': { kind: 'step-review'; form: 'notice'; summary: string; review?: ReviewRecord }
  }
}
interface Pending { candidate?: Candidate; results: RuleVerdict[]; error?: string; maxCorrections: number }

function feedback(pending: Pending, stopped: boolean): string {
  const parts = [pending.error ? '逐步骤审查发生故障，本次候选未放行。' : '本次候选被逐步骤审查拒绝。',
    '候选中的全部工具均未执行，候选文本未交付。',
    ...pending.results.filter(r => r.verdict.decision === 'reject').map(r =>
      '规则：' + r.ruleId + '\n原因：' + r.verdict.reason + '\n修改建议：\n' + r.verdict.suggestions.map(s => '- ' + s).join('\n')),
    ...(pending.error ? ['故障：' + pending.error] : []),
    stopped ? '自动订正已停止。请保留当前任务状态，等待用户处理审查配置或问题。'
      : '请结合原始任务上下文订正并重新生成响应。仍须遵循原有用户授权，审查建议只用于修正表达或候选内容。',
  ]
  if (pending.candidate) {
    parts.push('以下是被拒候选的数据，供订正参考：\n' + JSON.stringify(pending.candidate))
  }
  return parts.join('\n\n')
}

export async function apply(ctx: Context, config: LiveConfig): Promise<void> {
  const coordinator = reviewCoordinator(ctx)
  coordinator.retain(ctx, config)
  await coordinator.ensurePreset(ctx)
  registerReviewCatalog(ctx)
  const lifetime = new AbortController()
  const active = new Set<Agent>()
  const pending = new WeakMap<Agent, Pending>()
  const budgets = new WeakMap<Agent, { key: string; count: number }>()
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.effect(() => () => {
    for (const agent of active) agent.cancel({ kind: 'hook', reason: '逐步骤审查插件已卸载' }, { keepInbox: true })
    lifetime.abort(new Error('逐步骤审查插件已卸载'))
  })

  ctx.on('llm/stream', (request, next) => {
    if (request.sessionId !== undefined && coordinator.runs.has(request.sessionId)) return next()
    if (!isAgentLoopRequest(request)) return next()
    const settings = snapshot(config)
    if (!settings.enabled) return next()
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    if (!agent) throw new ReviewError('逐步骤审查无法确定所属 Agent')
    const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), lifetime.signal])
    return (async function* (): AsyncGenerator<StreamChunk> {
      active.add(agent)
      try {
        const chunks: StreamChunk[] = []
        const assembled = new BlockAssembler()
        let candidate: Candidate | undefined
        let failure: Pending | undefined
        let finished = false
        let phase = '主响应缓冲'
        try {
          signal.throwIfAborted()
          for await (const chunk of next()) {
            signal.throwIfAborted()
            if (finished) throw new ReviewError('模型在完成标记后继续输出')
            chunks.push(chunk)
            assembled.push(chunk)
            if (chunk.type === 'finish') finished = true
          }
          signal.throwIfAborted()
          if (!finished) throw new ReviewError('主模型响应缺少完成标记')
          const finish = assembled.finish
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            for (const chunk of chunks) if (chunk.type === 'usage' || chunk.type === 'finish') yield chunk
            return
          }
          const blocks = assembled.blocks()
          candidate = {
            text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
            tools: blocks.filter(b => b.type === 'tool-call').map(b => ({ name: b.name, arguments: b.arguments })),
          }
          phase = '机械匹配'
          const matched = await matchRules(settings.rules, candidate, signal)
          const results: RuleVerdict[] = []
          const evidence: ReviewEvidence[] = []
          for (const rule of matched) {
            signal.throwIfAborted()
            phase = '规则 ' + JSON.stringify(rule.id) + ' 的子 Agent 审查'
            const outcome = await reviewCandidate(ctx, settings, rule, candidate, request, signal)
            results.push({ ruleId: rule.id, verdict: outcome.verdict, reviewerSessionId: outcome.reviewerSessionId })
            evidence.push(...outcome.evidence)
          }
          signal.throwIfAborted()
          if (results.some(r => r.verdict.decision === 'reject')) failure = { candidate, results, maxCorrections: settings.maxCorrections }
          else {
            phase = '取证文件版本复核'
            await verifyEvidence(evidence, signal)
            signal.throwIfAborted()
            for (const chunk of chunks) { signal.throwIfAborted(); yield chunk }
            return
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason
          failure = { candidate, results: [], error: phase + '：' + safeErrorMessage(error), maxCorrections: settings.maxCorrections }
        }
        if (!failure) throw new ReviewError('逐步骤审查缺少终态')
        pending.set(agent, failure)
        if (assembled.usage) yield { type: 'usage', usage: assembled.usage }
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: failure.error ? FAILED : REJECTED,
          message: failure.error ? '逐步骤审查失败：' + failure.error : '逐步骤审查拒绝本次候选，等待订正。',
        } } }
      } finally { active.delete(agent) }
    })()
  }, { global: true, prepend: true })

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure.code !== REJECTED && payload.failure.code !== FAILED) return next()
    const item = pending.get(payload.agent)
    if (!item) throw new ReviewError('逐步骤审查恢复状态缺失，已停止本次响应')
    pending.delete(payload.agent)
    payload.signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
    const key = payload.turn + '/' + payload.step
    const previous = budgets.get(payload.agent)
    const count = previous?.key === key ? previous.count + 1 : 1
    budgets.set(payload.agent, { key, count })
    const stopped = Boolean(item.error) || count > item.maxCorrections
    payload.agent.session.append('user/message', createUserMessage({
        source: {
          kind: 'step-review', form: 'notice', summary: stopped ? '审查停止，等待处理' : '审查拒绝，要求原会话订正',
          review: { version: 1, turn: payload.turn, step: payload.step, correction: count, stopped,
            candidate: item.candidate, results: item.results, ...(item.error ? { error: item.error } : {}) },
        },
        content: [{ type: 'text', text: feedback(item, stopped) }],
      }), { surfaceOp: 'append' })
    if (stopped) throw new ReviewError(item.error ? '逐步骤审查故障：' + item.error : '逐步骤审查已达到自动订正次数上限')
    return { kind: 'retry' }
  }, { global: true, prepend: true })
}
