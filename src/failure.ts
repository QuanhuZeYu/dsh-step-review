import { LLM_FAILURE_CODES, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** 插件自身生成的安全诊断；外来异常文字不进入会话。 */
export class ReviewError extends Error {}

export function failureDetails(failure: LlmFailure): string {
  const details: string[] = []
  const { code, status } = failure
  if (Object.hasOwn(LLM_FAILURE_CODES, code)) details.push(code)
  const httpStatus = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status : /^HTTP_[1-5]\d{2}$/.test(code) ? Number(code.slice(5)) : undefined
  if (httpStatus !== undefined) details.push('HTTP ' + httpStatus)
  return details.join(' · ') || 'UNKNOWN'
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ReviewError) return error.message
  // 只读宿主归一化的错误事实，不展开 SDK 消息、cause 或自定义代码。
  return error instanceof LlmError ? '模型调用异常 · ' + failureDetails(error.failure) : '处理模型响应时发生异常 · UNKNOWN'
}
