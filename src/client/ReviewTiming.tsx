/** 原生统计保留原口径；这一行只展示插件保存的生成与审核采样。 */
import type { PreviewTiming } from './preview-timing.js'
import { previewTimingMetrics } from './preview-timing.js'
import css from './PreviewContent.module.css'
export function ReviewTiming({ timing }: { timing?: PreviewTiming }) {
  const { generationMs, reviewMs, outputTokens, tokensPerSecond } = previewTimingMetrics(timing)
  const parts: string[] = []
  if (generationMs !== undefined) parts.push('生成 ' + (generationMs / 1000).toFixed(2) + ' s')
  if (reviewMs !== undefined) parts.push('审核 ' + (reviewMs / 1000).toFixed(2) + ' s')
  if (outputTokens !== undefined) parts.push('输出 ' + outputTokens + ' tok')
  if (tokensPerSecond !== undefined) parts.push(tokensPerSecond.toFixed(1) + ' tok/s')
  return parts.length ? <p className={css.timing} title='插件采样：生成从首个有效 token 到模型结束；审核从模型结束到放行；速度不包含审核等待。'>
    <span>插件计时</span>{' · ' + parts.join(' · ')}
  </p> : null
}
