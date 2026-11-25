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
import { ReviewPreview } from './stream-preview.js'
import { reviewCoordinator, verifyEvidence, type ReviewEvidence } from './review-coordinator.js'
import './reviewer-preset.js'
import { failureDetails, ReviewError, safeErrorMessage } from './failure.js'
import { reviewMessageSource } from './review-record.js'
import { mountReviewDetails } from './review-details.js'
import type { Candidate, RuleVerdict, ReviewRecord } from './types.js'

export { Config }
export const name = 'step-review'
export const inject = ['llm', 'agents', 'agentPresets', 'storageDomain']
const REJECTED = 'STEP_REVIEW_REJECTED'
const FAILED = 'STEP_REVIEW_FAILED'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'step-review': { kind: 'step-review'; form: 'notice'; summary: string; review?: ReviewRecord }
  }
}
interface Pending { previewId?: string; candidate?: Candidate; results: RuleVerdict[]; error?: string; failure?: ReviewError; maxCorrections: number }

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
  await mountReviewDetails(ctx)
  const coordinator = reviewCoordinator(ctx)
  coordinator.retain(ctx, config)
  await coordinator.ensurePreset(ctx)
  const lifetime = new AbortController()
  const active = new Set<Agent>()
  const positions = new WeakMap<Agent, { turn: number; step: number }>()
  // 宿主在迭代模型流前发出 start，覆盖插件重载前已经预备的步骤。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') positions.set(agent, { turn: frame.turn, step: frame.step })
  }, { global: true })
  const pending = new WeakMap<Agent, Pending>()
  const budgets = new WeakMap<Agent, { key: string; count: number }>()
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.effect(() => () => {
    for (const agent of active) agent.cancel({ kind: 'hook', reason: '逐步骤审查插件已卸载' }, { keepInbox: true })
    lifetime.abort(new ReviewError('审查插件已卸载，当前未审核完的候选已取消，请继续任务以重新审核', { code: 'STEP_REVIEW_UNLOADED', stage: '插件卸载' }))
  })

  ctx.on('llm/stream', (request, next) => {
    if (request.sessionId !== undefined && coordinator.runs.has(request.sessionId)) return next()
    if (!isAgentLoopRequest(request)) return next()
    let settings: ReturnType<typeof snapshot>
    try { settings = snapshot(config) }
    catch (error) { throw new ReviewError('读取逐步骤审查配置失败', { code: 'STEP_REVIEW_CONFIG_READ_FAILED', stage: '审查配置', cause: error }) }
    if (!settings.enabled) return next()
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    if (!agent) throw new ReviewError('逐步骤审查无法确定所属 Agent', { code: 'STEP_REVIEW_PARENT_MISSING', stage: '主响应入口' })
    if (!coordinator.claimRequest(request)) return next()
    const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), lifetime.signal])
    return (async function* (): AsyncGenerator<StreamChunk> {
      active.add(agent)
      let preview: ReviewPreview | undefined
      let reviewTimer: ReturnType<typeof setTimeout> | undefined
      try {
        signal.throwIfAborted()
        const position = positions.get(agent)
        if (!position) throw new ReviewError('宿主流开始事件未提供当前步骤位置，请继续任务以重新准备请求', { code: 'STEP_REVIEW_POSITION_MISSING', stage: '主响应入口' })
        const chunks: StreamChunk[] = []
        const assembled = new BlockAssembler()
        let candidate: Candidate | undefined
        let failure: Pending | undefined
        let finished = false
        let phase = '主响应缓冲'
        const results: RuleVerdict[] = []
        try {
          signal.throwIfAborted()
          preview = new ReviewPreview(agent.session, position.turn, position.step, error => ctx.logger.warn('待审预览已停用，继续业务审查：' + safeErrorMessage(error)))
          for await (const source of next()) {
            // 缓冲期间保留每次出现的值，避免自定义上游复用对象。
            const chunk = structuredClone(source)
            signal.throwIfAborted()
            if (finished) throw new ReviewError('模型在完成标记后继续输出', { code: 'STEP_REVIEW_STREAM_PROTOCOL', stage: '主响应缓冲' })
            chunks.push(chunk)
            assembled.push(chunk)
            preview.push(chunk)
            if (chunk.type === 'finish') finished = true
          }
          signal.throwIfAborted()
          if (!finished) throw new ReviewError('主模型响应缺少完成标记', { code: 'STEP_REVIEW_STREAM_INCOMPLETE', stage: '主响应缓冲' })
          const finish = assembled.finish
          preview.finishModel(assembled.usage?.outputTokens)
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            for (const chunk of chunks) {
              if (chunk.type === 'usage') yield chunk
              else if (chunk.type === 'finish') {
                if ((chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') && chunk.reason.failure.code === 'UNKNOWN') {
                  yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, code: 'STEP_REVIEW_UPSTREAM_FAILED', message: '主模型响应失败：' + failureDetails(chunk.reason.failure) } } }
                } else yield chunk
              }
            }
            return
          }
          const blocks = assembled.blocks()
          candidate = {
            text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
            tools: blocks.filter(b => b.type === 'tool-call').map(b => ({ name: b.name, arguments: b.arguments })),
          }
          const reviewController = new AbortController()
          const reviewSignal = AbortSignal.any([signal, reviewController.signal])
          reviewTimer = setTimeout(() => reviewController.abort(new ReviewError('候选在' + phase + '阶段超过审查总期限（' + settings.timeoutMs + ' 毫秒）', { code: 'STEP_REVIEW_CANDIDATE_TIMEOUT', stage: phase })), settings.timeoutMs)
          phase = '机械匹配'
          preview.reviewing(candidate)
          const matched = await matchRules(settings.rules, candidate, reviewSignal)
          // 证据漂移允许在同一候选上重新审查一次，全部阶段共用候选期限。
          for (let attempt = 0; attempt < 2; attempt++) {
            results.length = 0
            const evidence: ReviewEvidence[] = []
            for (const rule of matched) {
              reviewSignal.throwIfAborted()
              phase = '规则 ' + JSON.stringify(rule.id) + ' 的独立审查'
              const outcome = await reviewCandidate(ctx, settings, rule, candidate, request, reviewSignal,
                id => preview!.reviewing(candidate!, rule.id, id))
              results.push({ ruleId: rule.id, verdict: outcome.verdict, reviewerSessionId: outcome.reviewerSessionId })
              evidence.push(...outcome.evidence)
              // 已有明确拒绝就反馈，后续规则故障不得吞掉本次自动订正机会。
              if (outcome.verdict.decision === 'reject') break
            }
            reviewSignal.throwIfAborted()
            if (results.some(result => result.verdict.decision === 'reject')) {
              failure = { previewId: preview.id, candidate, results: [...results], maxCorrections: settings.maxCorrections }
              break
            }
            if (settings.stopOnEvidenceChange) {
              phase = '取证文件版本复核'
              try { await verifyEvidence(evidence, reviewSignal) }
              catch (error) {
                if (attempt === 0 && error instanceof ReviewError && (error.code === 'STEP_REVIEW_EVIDENCE_CHANGED' || error.code === 'STEP_REVIEW_EVIDENCE_TARGET_CHANGED')) continue
                throw error
              }
            }
            reviewSignal.throwIfAborted()
            clearTimeout(reviewTimer)
            reviewTimer = undefined
            for (const chunk of chunks) { signal.throwIfAborted(); yield chunk }
            // 只在完整回放后隐藏预览，取消期间仍能查看未交付候选。
            preview.release()
            return
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason
          const reason = new ReviewError(phase + '失败', { code: error instanceof ReviewError ? error.code : 'STEP_REVIEW_GATE_FAILED', stage: phase, cause: error })
          failure = { previewId: preview?.id, candidate, results: [...results], error: reason.message, failure: reason, maxCorrections: settings.maxCorrections }
        }
        if (!failure) throw new ReviewError('逐步骤审查缺少终态', { code: 'STEP_REVIEW_TERMINAL_MISSING', stage: phase })
        pending.set(agent, failure)
        if (assembled.usage) yield { type: 'usage', usage: assembled.usage }
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: failure.error ? FAILED : REJECTED,
          message: failure.error ? '逐步骤审查失败：' + failure.error : '逐步骤审查拒绝本次候选，等待订正。',
        } } }
      } finally {
        clearTimeout(reviewTimer)
        // 展示记录清理不能覆盖已选择的审核结果、故障反馈或取消。
        try { preview?.close() } catch { ctx.logger.warn('待审预览关闭失败，请检查会话记录存储') }
        finally { active.delete(agent) }
      }
    })()
  }, { global: true, prepend: true })

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure.code !== REJECTED && payload.failure.code !== FAILED) return next()
    const item = pending.get(payload.agent)
    if (!item) return next()
    payload.signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
    const key = payload.turn + '/' + payload.step
    const previous = budgets.get(payload.agent)
    const count = previous?.key === key ? previous.count + 1 : 1
    budgets.set(payload.agent, { key, count })
    const stopped = Boolean(item.error) || count > item.maxCorrections
    try {
      payload.agent.session.append('user/message', createUserMessage({
        source: reviewMessageSource(item, payload.turn, payload.step, count, stopped, payload.agent.id),
        content: [{ type: 'text', text: feedback(item, stopped) }],
      }), { surfaceOp: 'append' })
    } catch (error) {
      throw new ReviewError('无法写入审查反馈：' + safeErrorMessage(error) + (item.error ? '\n原审查故障：' + item.error : ''), { code: 'STEP_REVIEW_FEEDBACK_WRITE_FAILED', stage: '主会话反馈', cause: error })
    }
    pending.delete(payload.agent)
    if (stopped) throw item.failure ?? new ReviewError('逐步骤审查已达到自动订正次数上限（' + item.maxCorrections + ' 次），请查看拒绝原因与修改建议', { code: 'STEP_REVIEW_CORRECTIONS_EXHAUSTED', stage: '主会话订正' })
    return { kind: 'retry' }
  }, { global: true, prepend: true })
}