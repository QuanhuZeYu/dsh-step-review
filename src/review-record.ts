/** 创建可直接写入 Session 日志的订正消息来源。 */
import type { Candidate, ReviewRecord, RuleVerdict } from './types.js'

interface PendingReview {
  previewId?: string
  candidate?: Candidate
  results: RuleVerdict[]
  error?: string
}

/** 仅写入有值的可选字段，保持 Session 消息可无损 JSON 序列化。 */
export function reviewMessageSource(
  item: PendingReview,
  turn: number,
  step: number,
  correction: number,
  stopped: boolean,
  parentSessionId: string,
): { kind: 'step-review'; form: 'notice'; summary: string; review: ReviewRecord } {
  const review: ReviewRecord = {
    version: 1,
    parentSessionId,
    ...(item.previewId === undefined ? {} : { previewId: item.previewId }),
    turn,
    step,
    correction,
    stopped,
    ...(item.candidate === undefined ? {} : { candidate: item.candidate }),
    results: item.results,
    ...(item.error === undefined ? {} : { error: item.error }),
  }
  return {
    kind: 'step-review',
    form: 'notice',
    summary: stopped ? '审查停止，等待处理' : '审查拒绝，要求原会话订正',
    review,
  }
}
