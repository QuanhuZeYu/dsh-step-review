import { reviewDetailPath, type ReviewDetailSnapshot, type ReviewDetailSelection, type ReviewDetailSummary } from '../review-detail-types.js'

async function request<T>(body: object, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(reviewDetailPath, document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error('审查详情不可用或已删除。')
    throw new Error('审查详情请求失败（HTTP ' + response.status + '）。')
  }
  return response.json() as Promise<T>
}

export function listReviewDetails(parentSessionId: string, signal: AbortSignal): Promise<ReviewDetailSummary[]> {
  return request({ action: 'list', parentSessionId }, signal)
}

export function getReviewDetail(parentSessionId: string, id: string, signal: AbortSignal): Promise<ReviewDetailSnapshot> {
  return request({ action: 'get', parentSessionId, id }, signal)
}

export function deleteReviewDetails(parentSessionId: string, selection: ReviewDetailSelection, signal: AbortSignal): Promise<number> {
  return request({ action: 'delete', parentSessionId, selection }, signal)
}
