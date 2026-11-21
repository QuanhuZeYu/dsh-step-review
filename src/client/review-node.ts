/** 将本插件的订正注入独占投影为审查卡片，兼容早期文本记录。 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Candidate, ReviewRecord, RuleVerdict } from '../types.js'

export interface ReviewCardData {
  injection: string
  record?: ReviewRecord
  candidate?: Candidate
  candidateIncomplete: boolean
  results: RuleVerdict[]
  stopped: boolean
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'step-review': ReviewCardData }
}
export const marker = '以下是被拒候选的数据，供订正参考：\n'
function candidateOf(value: unknown): value is Candidate {
  if (!value || typeof value !== 'object') return false
  const item = value as Candidate
  return typeof item.text === 'string' && Array.isArray(item.tools)
    && item.tools.every(tool => tool && typeof tool.name === 'string' && typeof tool.arguments === 'string')
}
export function cardData(source: unknown, injection: string): ReviewCardData {
  const review = (source as { review?: ReviewRecord } | undefined)?.review
  if (review?.version === 1 && Array.isArray(review.results)) return {
    injection, record: review, candidate: review.candidate, candidateIncomplete: false,
    results: review.results, stopped: review.stopped,
  }
  let candidate: Candidate | undefined
  const position = injection.indexOf(marker)
  if (position >= 0) {
    try { const value: unknown = JSON.parse(injection.slice(position + marker.length)); if (candidateOf(value)) candidate = value } catch { /* 旧记录可能已在保存时截断，保留完整注入供查看。 */ }
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
interface ReviewState extends ReviewCardData { seq: number }
export const reviewDefinition: ConversationNodeDefinition<ReviewState> = {
  kind: 'step-review-injection', target: 'chat',
  match: event => event.type === 'user/message' && (event.data.source as { kind: string }).kind === 'step-review'
    && event.surfaceOp === 'append'
    ? { id: String(event.data.id), role: 'start', exclusive: true } : null,
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('审查卡片需要 user/message')
    const event = match.event
    const injection = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return { seq: event.seq, ...cardData(event.data.source, injection) }
  },
  update: context => context.state,
  buildViewNode: context => {
    if (!context.state) return null
    const { seq, ...data } = context.state
    return { key: context.key, id: context.id, kind: 'step-review', target: 'chat', anchorSeq: seq,
      location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data }
  },
}
