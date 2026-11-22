import { LLM_FAILURE_CODES, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { SubagentError } from '@deepseek-ai/dsh-subagent'

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

const subagentFailures: Readonly<Record<string, string>> = {
  ACTIVATION_LIMIT_REACHED: '原生子 Agent 并发容量已满，请等待其他任务结束后重试',
  NO_PROVIDER: '尚未加载 spawn 后端，请检查原生子 Agent 插件',
  UNSUPPORTED_CAPABILITY: '当前子 Agent 后端不支持所需的审查能力',
  UNAUTHORIZED: '主 Agent 身份或权限范围已变化，请重新发起请求',
  DRAINING: '宿主正在关闭子 Agent 运行环境，请等待重新加载完成',
  ACTIVATION_CLOSING: '相关 Agent 正在关闭，请等待重新加载完成',
  PROVIDER_CHANGED: '子 Agent 后端在启动时发生变化，请重新发起请求',
  PERSISTENCE_UNAVAILABLE: '子会话持久化服务不可用，请检查宿主配置',
  ACTIVATION_TEARDOWN_FAILED: '子 Agent 未能完整释放，请检查宿主运行状态',
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ReviewError) return error.message
  if (error instanceof SubagentError && Object.hasOwn(subagentFailures, error.code)) return subagentFailures[error.code] + ' · ' + error.code
  if (error instanceof TypeError) return '内部类型异常 · TypeError'
  if (error instanceof ReferenceError) return '内部引用异常 · ReferenceError'
  if (error instanceof RangeError) return '内部范围异常 · RangeError'
  // 只读宿主归一化的错误事实，不展开 SDK 消息、cause 或自定义代码。
  return error instanceof LlmError ? '模型调用异常 · ' + failureDetails(error.failure) : '处理模型响应时发生异常 · UNKNOWN'
}
