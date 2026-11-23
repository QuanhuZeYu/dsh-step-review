/** 待审展示信息，不进入模型消息与工具调度。 */
import type { Candidate } from './types.js'

export const previewRecordType = 'plugin:step-review/preview' as const
export type PreviewPhase = 'generating' | 'reviewing' | 'released' | 'cancelled'
export interface PreviewPart {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  name?: string
  /** block-end 用完整值替换累计增量。 */
  replace?: boolean
}
export interface PreviewRecord {
  version: 1
  previewId: string
  turn: number
  step: number
  phase: PreviewPhase
  parts?: PreviewPart[]
  /** 进入审核时的完整展示快照，可独立恢复。 */
  snapshot?: PreviewPart[]
  candidate?: Candidate
  ruleId?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:step-review/preview': PreviewRecord }
}
