/** 审查会话索引写入主会话日志，不修改原生子 Agent 分类。 */
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'

export const reviewActivityType = 'plugin:step-review/activity' as const
export interface ReviewActivity {
  version: 1
  reviewerSessionId: string
  parentSessionId: string
  ruleId: string
  phase: 'started' | 'completed' | 'failed'
  time: number
  error?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:step-review/activity': ReviewActivity }
}
/** 写入审查阶段，供插件目录刷新后恢复。 */
export function appendReviewActivity(
  session: Session,
  activity: Omit<ReviewActivity, 'version'>,
): void {
  appendPluginRecord(session, reviewActivityType, { version: 1, ...activity })
}
