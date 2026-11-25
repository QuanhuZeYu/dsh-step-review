/** 保留的审查会话命名空间，主会话和历史审查仍可使用原有 ID。 */
export const reviewSessionPrefix = 'step-review-'
const reviewUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isReviewSessionId(id: string): boolean {
  return id.startsWith(reviewSessionPrefix) && reviewUuid.test(id.slice(reviewSessionPrefix.length))
}
