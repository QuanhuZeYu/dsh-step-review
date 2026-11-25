/** 预览与订正注入共用节点；协议见 preview-types 与流式待审展示设计、计划。 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { previewRecordType, type PreviewPart, type PreviewPhase, type PreviewRecord } from '../preview-types.js'
import type { Candidate, ReviewRecord, RuleVerdict } from '../types.js'
import { previewTimingOf, type PreviewTiming } from './preview-timing.js'

export interface PreviewData {
  id: string
  turn: number
  step: number
  phase: PreviewPhase | 'interrupted'
  parts: PreviewPart[]
  incomplete: boolean
  ruleId?: string
  reviewerSessionId?: string
  parentSessionId?: string
  timing?: PreviewTiming
}
export interface ReviewAttemptData {
  injection: string
  record?: ReviewRecord
  candidate?: Candidate
  candidateIncomplete: boolean
  results: RuleVerdict[]
  stopped: boolean
  rejectedAt?: number
  preview?: PreviewData
}
export interface ReviewCardData extends ReviewAttemptData {
  /** 同一步先前尝试只在历史中展示，模型注入与原始日志保持完整。 */
  history?: ReviewAttemptData[]
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'step-review': ReviewCardData }
}
export const marker = '以下是被拒候选的数据，供订正参考：\n'
function objectOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function candidateOf(value: unknown): value is Candidate {
  return objectOf(value) && typeof value.text === 'string' && Array.isArray(value.tools)
    && value.tools.every(tool => objectOf(tool) && typeof tool.name === 'string' && typeof tool.arguments === 'string')
}
function resultOf(value: unknown): value is RuleVerdict {
  if (!objectOf(value) || typeof value.ruleId !== 'string' || !objectOf(value.verdict)) return false
  const verdict = value.verdict
  return (verdict.decision === 'pass' || verdict.decision === 'reject') && typeof verdict.reason === 'string'
    && Array.isArray(verdict.suggestions) && verdict.suggestions.every(item => typeof item === 'string')
    && (value.reviewerSessionId === undefined || typeof value.reviewerSessionId === 'string')
}
function reviewOf(source: unknown): ReviewRecord | undefined {
  const review = objectOf(source) ? source.review : undefined
  if (!objectOf(review) || review.version !== 1 || !coordinate(review.turn) || !coordinate(review.step)
    || !coordinate(review.correction) || typeof review.stopped !== 'boolean' || !Array.isArray(review.results)
    || !review.results.every(resultOf) || (review.candidate !== undefined && !candidateOf(review.candidate))
    || (review.error !== undefined && typeof review.error !== 'string')
    || (review.parentSessionId !== undefined && (typeof review.parentSessionId !== 'string' || !review.parentSessionId))
    || (review.previewId !== undefined && (typeof review.previewId !== 'string' || !review.previewId))) return undefined
  return review as unknown as ReviewRecord
}
function partOf(value: unknown): value is PreviewPart {
  return objectOf(value) && coordinate(value.index) && (value.kind === 'text' || value.kind === 'reasoning' || value.kind === 'tool-call')
    && typeof value.text === 'string' && (value.name === undefined || typeof value.name === 'string')
    && (value.replace === undefined || typeof value.replace === 'boolean')
}
function previewOf(value: unknown): PreviewRecord | undefined {
  if (!objectOf(value) || value.version !== 1 || typeof value.previewId !== 'string' || !value.previewId
    || !coordinate(value.turn) || !coordinate(value.step)
    || (value.phase !== 'generating' && value.phase !== 'reviewing' && value.phase !== 'released' && value.phase !== 'cancelled')
    || (value.parts !== undefined && (!Array.isArray(value.parts) || !value.parts.every(partOf)))
    || (value.snapshot !== undefined && (!Array.isArray(value.snapshot) || !value.snapshot.every(partOf)))
    || (value.candidate !== undefined && !candidateOf(value.candidate))
    || (value.ruleId !== undefined && typeof value.ruleId !== 'string')
    || (value.parentSessionId !== undefined && (typeof value.parentSessionId !== 'string' || !value.parentSessionId))
    || (value.reviewerSessionId !== undefined && (typeof value.reviewerSessionId !== 'string' || !value.reviewerSessionId))) return undefined
  return value as unknown as PreviewRecord
}
export function cardData(source: unknown, injection: string): ReviewCardData {
  const review = reviewOf(source)
  if (review) return {
    injection, record: review, candidate: review.candidate, candidateIncomplete: false,
    results: review.results, stopped: review.stopped,
  }
  let candidate: Candidate | undefined
  const position = injection.indexOf(marker)
  if (position >= 0) {
    try { const value: unknown = JSON.parse(injection.slice(position + marker.length)); if (candidateOf(value)) candidate = value } catch { /* 旧记录可能已截断，保留完整注入供查看。 */ }
  }
  const results: RuleVerdict[] = []
  const head = position < 0 ? injection : injection.slice(0, position)
  for (const match of head.matchAll(/规则：([^\n]+)\n原因：([\s\S]*?)\n修改建议：\n([\s\S]*?)(?=\n\n|$)/g)) {
    results.push({ ruleId: match[1], verdict: { decision: 'reject', reason: match[2],
      suggestions: match[3].split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) } })
  }
  return { injection, candidate, candidateIncomplete: position >= 0 && !candidate,
    results, stopped: head.includes('自动订正已停止') }
}
interface ReviewState extends ReviewCardData { seq: number; attemptId: string }
type MatchEvent = Parameters<ConversationNodeDefinition['match']>[0]
function eventPreview(event: MatchEvent): PreviewRecord | undefined {
  // 信息记录不属于已发布 SessionEventMap；仅认领本插件命名与经过校验的数据。
  return (event.type as string) === previewRecordType && 'ignorable' in event && event.ignorable === true
    ? previewOf(event.data) : undefined
}
function isInjection(event: MatchEvent): event is Extract<MatchEvent, { type: 'user/message' }> {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return false
  const source: unknown = event.data.source
  return objectOf(source) && source.kind === 'step-review'
}
function mergeParts(current: PreviewPart[], parts: PreviewPart[]): PreviewPart[] {
  const merged = new Map(current.map(part => [part.index, part]))
  for (const part of parts) {
    const previous = merged.get(part.index)
    merged.set(part.index, { ...part, name: part.name ?? previous?.name,
      text: part.replace || !previous || previous.kind !== part.kind ? part.text : previous.text + part.text })
  }
  return [...merged.values()].sort((left, right) => left.index - right.index)
}
/** 同一步的当前尝试替换展示，先前尝试只归档一次；迟到清理不重新激活旧尝试。 */
function beginAttempt(state: ReviewState | undefined, attemptId: string): ReviewState | undefined {
  if (!state || state.attemptId === attemptId) return state
  if (state.history?.some(item => (item.preview?.id ?? item.record?.previewId) === attemptId)) return undefined
  const { seq: anchor, attemptId: previousId, history = [], ...previous } = state
  const preview = previous.preview
  const archived = preview && !previous.injection && (preview.phase === 'generating' || preview.phase === 'reviewing')
    ? { ...previous, preview: { ...preview, phase: 'interrupted' as const } } : previous
  return { seq: anchor, attemptId, injection: '', candidateIncomplete: false, results: [], stopped: false,
    history: [...history, archived] }
}
function applyEvent(state: ReviewState | undefined, event: MatchEvent): ReviewState {
  const value = eventPreview(event)
  const record = isInjection(event) ? reviewOf(event.data.source) : undefined
  const attemptId = value?.previewId ?? record?.previewId ?? 'legacy:' + String(event.seq)
  const current = beginAttempt(state, attemptId)
  if (state && !current) return state
  if (isInjection(event)) {
    const injection = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return { seq: current?.seq ?? event.seq, attemptId, ...cardData(event.data.source, injection),
      rejectedAt: event.time, preview: current?.preview, history: current?.history }
  }
  if (!value) throw new Error('待审节点需要有效的预览或订正记录')
  // 拒绝为本次尝试最终展示；随后取消清理不能覆盖已保存的反馈。
  if (current?.injection) return current
  const previous = current?.preview
  if (current && (previous?.phase === 'released' || previous?.phase === 'cancelled')) return current
  const parts = value.snapshot ? mergeParts([], value.snapshot) : mergeParts(previous?.parts ?? [], value.parts ?? [])
  return { seq: current?.seq ?? event.seq, attemptId, injection: '', candidateIncomplete: false, results: [], stopped: false,
    candidate: value.candidate ?? current?.candidate, history: current?.history,
    preview: { id: value.previewId, turn: value.turn, step: value.step, phase: value.phase, parts,
      incomplete: value.snapshot ? false : previous?.incomplete ?? (value.phase !== 'generating' || !!value.parts?.length),
      ruleId: value.ruleId ?? previous?.ruleId, reviewerSessionId: value.reviewerSessionId ?? previous?.reviewerSessionId,
      parentSessionId: value.parentSessionId ?? previous?.parentSessionId,
      timing: previewTimingOf(value.timing) ?? previous?.timing } }
}
export const reviewDefinition: ConversationNodeDefinition<ReviewState> = {
  kind: 'step-review-injection', target: 'chat',
  match: event => {
    const preview = eventPreview(event)
    if (preview) return { id: 'step:' + preview.turn + ':' + preview.step, role: 'start' }
    if (!isInjection(event)) return null
    const record = reviewOf(event.data.source)
    return { id: record ? 'step:' + record.turn + ':' + record.step : 'legacy:' + String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => applyEvent(undefined, match.event),
  update: (context, match) => applyEvent(context.state, match.event),
  buildViewNode: context => {
    if (!context.state) return null
    const { seq, attemptId, ...data } = context.state
    const location = context.start?.location ?? { kind: 'unresolved' as const }
    const preview = data.preview
    const closed = location.kind === 'step' ? location.step.status === 'closed' || location.turn.status === 'closed'
      : location.kind === 'turn' && location.turn.status === 'closed'
    if (preview && !data.injection && closed && (preview.phase === 'generating' || preview.phase === 'reviewing')) {
      data.preview = { ...preview, phase: 'interrupted' }
    }
    const hasRejection = Boolean(data.injection || data.history?.some(attempt => attempt.injection))
    return { key: context.key, id: context.id, kind: 'step-review', target: 'chat', anchorSeq: seq,
      location, groupTree: 'turn', visibility: preview?.phase === 'released' && !hasRejection ? 'hidden' : 'visible', data }
  },
}
