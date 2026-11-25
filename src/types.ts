/** 配置、候选响应与审查裁决的共享契约。 */
export interface Rule {
  id: string
  enabled: boolean
  target: 'text' | 'tools' | 'all'
  matchMode: 'contains' | 'regex' | 'always'
  patterns: string[]
  prompt: string
  provider: string
  model: string
  reasoningEffort?: string | null
}
export interface StepReviewSettings {
  enabled: boolean
  provider: string
  model: string
  reasoningEffort?: string | null
  reviewerPreset: string
  timeoutMs: number
  maxReviewSteps: number
  maxConcurrentReviews: number
  maxCorrections: number
  includeUserRequest: boolean
  stopOnEvidenceChange: boolean
  rules: Rule[]
}
export interface Candidate {
  text: string
  tools: { name: string; arguments: string }[]
}
export interface Verdict {
  decision: 'pass' | 'reject'
  reason: string
  suggestions: string[]
}
export interface RuleVerdict { ruleId: string; verdict: Verdict; reviewerSessionId?: string }
/** 与一次订正注入同时保存的展示数据；工具参数仅为记录。 */
export interface ReviewRecord {
  version: 1
  /** 同一次候选从流式预览转为拒绝块时保留节点身份。 */
  previewId?: string
  parentSessionId?: string
  turn: number
  step: number
  correction: number
  stopped: boolean
  candidate?: Candidate
  results: RuleVerdict[]
  error?: string
}
