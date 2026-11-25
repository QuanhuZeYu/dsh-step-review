/** 仅按插件保存的时间采样计算，缺失端点不回退到消息发布时间。 */
import type { PreviewRecord } from '../preview-types.js'
export type PreviewTiming = NonNullable<PreviewRecord['timing']>
function sample(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function previewTimingOf(value: unknown): PreviewTiming | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const timing = value as Record<string, unknown>
  if (!sample(timing.startedAt)) return undefined
  for (const key of ['firstTokenAt', 'finishedAt', 'releasedAt', 'outputTokens']) {
    if (timing[key] !== undefined && !sample(timing[key])) return undefined
  }
  const result = timing as unknown as PreviewTiming
  if ((result.firstTokenAt !== undefined && result.firstTokenAt < result.startedAt)
    || (result.finishedAt !== undefined && result.finishedAt < (result.firstTokenAt ?? result.startedAt))
    || (result.releasedAt !== undefined && result.releasedAt < (result.finishedAt ?? result.firstTokenAt ?? result.startedAt))) return undefined
  return result
}
export function previewTimingMetrics(value: unknown): { generationMs?: number; reviewMs?: number; outputTokens?: number; tokensPerSecond?: number } {
  const timing = previewTimingOf(value)
  if (!timing) return {}
  const generationMs = timing.firstTokenAt !== undefined && timing.finishedAt !== undefined
    ? timing.finishedAt - timing.firstTokenAt : undefined
  const reviewMs = timing.finishedAt !== undefined && timing.releasedAt !== undefined
    ? timing.releasedAt - timing.finishedAt : undefined
  const tokensPerSecond = generationMs !== undefined && generationMs > 0 && timing.outputTokens !== undefined && timing.outputTokens > 0
    ? timing.outputTokens * 1000 / generationMs : undefined
  return { generationMs, reviewMs, outputTokens: timing.outputTokens, tokensPerSecond }
}
