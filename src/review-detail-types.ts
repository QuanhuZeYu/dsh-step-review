export interface ReviewDetailSummary {
  id: string
  parentSessionId: string
  ruleId: string
  startedAt: number
  finishedAt: number
  decision?: 'pass' | 'reject'
  reason?: string
  error?: string
}

export interface ReviewDetail extends ReviewDetailSummary {
  events: readonly unknown[]
}

export type ReviewDetailSnapshot = ReviewDetail | (Omit<ReviewDetail, 'finishedAt'> & { finishedAt: null })

export type ReviewDetailSelection = { ids: string[] } | { passed: true }

export const reviewDetailPath = 'api/step-review.details'
