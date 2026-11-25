import { types } from 'node:util'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

const messageLimit = 1200
const detailLimit = 4000
const causeDepth = 3
const aggregateLimit = 3
const reviewSummaries = new WeakMap<object, string>()

/** 仅读取数据属性，SDK 的 getter、toString 和迭代器均不参与诊断。 */
function dataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  if (types.isProxy(value)) return undefined
  try {
    let current: object | null = value
    for (let depth = 0; current !== null && depth < 8; depth++) {
      if (types.isProxy(current)) return undefined
      const property = Object.getOwnPropertyDescriptor(current, key)
      if (property !== undefined) return 'value' in property ? property.value : undefined
      current = Object.getPrototypeOf(current)
    }
  } catch {
    // 不可信对象的属性代理失败时，继续使用已取得的安全事实。
  }
  return undefined
}

function bounded(value: string, limit: number): string {
  const suffix = '…（已截断）'
  return value.length > limit ? value.slice(0, Math.max(0, limit - suffix.length)) + suffix : value
}

/** 保留诊断正文；凭据、候选与嵌入的 SDK 载荷不进入会话。 */
function safeText(value: unknown, limit = messageLimit): string {
  if (typeof value !== 'string') return ''
  const text = value.slice(0, 32768)
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END[\s\S]*?PRIVATE KEY-----|$)/gi, '<凭据已隐藏>')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '<凭据已隐藏>')
    .replace(/((?:set-cookie|cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1<凭据已隐藏>')
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '<凭据已隐藏>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '<凭据已隐藏>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<凭据已隐藏>@')
    .replace(/([?&][^\s=&#]+)=([^\s&#]*)/g, '$1=<已隐藏>')
    .replace(/((?:api[_ -]?key|access[_ -]?key|secret|password|passwd|authorization|credential|(?:access|refresh|id)[_ -]?token|token|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1<凭据已隐藏>')
    .replace(/(?:\{\s*["']|\[\s*[\{"'])[\s\S]*/g, '<载荷已隐藏>')
    .replace(/((?:candidate|latestUserRequest|messages|prompt|request[_ -]?body|response[_ -]?body|payload|待审材料|候选(?:内容|正文)?)["']?\s*[:=：]\s*)[\s\S]*/gi, '$1<内容已隐藏>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  return bounded(text, limit)
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_./:-]{0,119}$/.test(value) && safeText(value, 120) === value
    ? value : fallback
}

/** 公开 cause 只承载安全快照，宿主递归渲染时不能重新触达原始异常。 */
function publicCause(error: unknown): Error {
  const snapshot = new Error(safeErrorMessage(error))
  const rawName = dataProperty(error, 'name')
  const name = typeof rawName === 'string' && /^(?:[A-Za-z][A-Za-z0-9]*Error|Error)$/.test(rawName) ? rawName : 'Error'
  snapshot.name = name
  const fallback = types.isNativeError(error) ? name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() : 'UNEXPECTED_THROW'
  Object.defineProperty(snapshot, 'code', { value: safeCode(dataProperty(error, 'code'), fallback), enumerable: true })
  const stage = safeText(dataProperty(error, 'stage'), 120)
  if (stage) Object.defineProperty(snapshot, 'stage', { value: stage, enumerable: true })
  return Object.freeze(snapshot)
}

function httpStatus(failure: unknown): number | undefined {
  const status = dataProperty(failure, 'status')
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status
  const code = dataProperty(failure, 'code')
  return typeof code === 'string' && /^HTTP_[1-5]\d{2}$/.test(code) ? Number(code.slice(5)) : undefined
}

export type ReviewErrorOptions = ErrorOptions & { code?: string; stage?: string; retryable?: boolean }

/** 宿主通过 LlmError 身份保留自定义 code 与安全的详细 failure。 */
export class ReviewError extends LlmError {
  readonly stage?: string
  readonly retryable?: boolean

  constructor(message: string, options?: ReviewErrorOptions) {
    const cause = dataProperty(options, 'cause')
    const summary = safeText(message) || '逐步骤审查内部操作失败'
    const safeCause = cause === undefined ? undefined : publicCause(cause)
    const detail = safeCause === undefined ? summary : bounded(summary + '；原因：' + safeCause.message, detailLimit)
    const observedCode = safeCode(dataProperty(options, 'code'), 'STEP_REVIEW_INTERNAL')
    const code = observedCode.toUpperCase() === 'UNKNOWN' ? 'STEP_REVIEW_INTERNAL' : observedCode
    // 宿主工厂 fromFailure 也以此方式将已观察的自定义 code 传入构造器。
    super(detail, code as ConstructorParameters<typeof LlmError>[1], safeCause === undefined ? undefined : { cause: safeCause })
    this.name = 'ReviewError'
    reviewSummaries.set(this, detail)
    const stage = safeText(dataProperty(options, 'stage'), 120)
    if (stage) this.stage = stage
    const retryable = dataProperty(options, 'retryable')
    if (typeof retryable === 'boolean') this.retryable = retryable
  }
}

export function failureDetails(failure: LlmFailure): string {
  const code = safeCode(dataProperty(failure, 'code'), 'MODEL_FAILURE')
  const status = httpStatus(failure)
  const message = safeText(dataProperty(failure, 'message'))
  return [code, ...(status === undefined ? [] : ['HTTP ' + status]), ...(message ? [message] : [])].join(' · ')
}

/** 仅用结构化事实判定有界重试，认证、配置和预算错误优先排除。 */
export function isTransientFailure(failure: LlmFailure): boolean {
  const code = safeCode(dataProperty(failure, 'code'), '').toUpperCase()
  const status = httpStatus(failure)
  if (/(?:AUTH|CREDENTIAL|TOKEN|SIGN_IN|PERMISSION|FORBIDDEN|CONFIG|PRESET|UNKNOWN_MODEL|MODEL_UNSUPPORTED|INVALID_MODEL|ADAPTER|QUOTA|BUDGET|BALANCE|PAYMENT|CONTEXT|INVALID_REQUEST|UNSUPPORTED|ABORTED)/.test(code)) return false
  if (status !== undefined) return status === 408 || status === 429 || status >= 500
  return /^(?:RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT|STREAM_CLOSED|CONNECTION_ERROR|CONNECTION_RESET|NETWORK_ERROR|FETCH_ERROR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(code)
}

const subagentFailures: Readonly<Record<string, string>> = {
  ACTIVATION_LIMIT_REACHED: '原生子 Agent 并发容量已满，请等待其他任务结束后重试',
  NO_PROVIDER: '尚未加载 spawn 后端，请检查原生子 Agent 插件',
  UNSUPPORTED_CAPABILITY: '当前子 Agent 后端不支持所需的审查能力',
  UNAUTHORIZED: '主 Agent 身份或权限范围已变化，请重新发起请求',
  DRAINING: '宿主正在关闭子 Agent 运行环境，请等待重新加载完成',
  ACTIVATION_CLOSING: '相关 Agent 正在关闭，请等待重新加载完成',
  PROVIDER_CHANGED: '子 Agent 后端在启动时发生变化，请重新发起请求',
  PRESET_UNAVAILABLE: '审查 Agent preset 服务不可用',
  PERSISTENCE_UNAVAILABLE: '子会话持久化服务不可用，请检查宿主配置',
  ACTIVATION_TEARDOWN_FAILED: '子 Agent 未能完整释放，请检查宿主运行状态',
  'agent-preset/invalid': '审查预设无法加载',
  'agent-preset/not-found': '找不到审查预设',
}

function describe(error: unknown, depth: number, seen: Set<object>): string {
  if (depth > causeDepth) return '原因链已达深度上限'
  const object = typeof error === 'object' && error !== null
  if (object) {
    if (seen.has(error)) return '原因链循环引用'
    seen.add(error)
  }
  const nativeError = types.isNativeError(error)
  const rawName = nativeError ? dataProperty(error, 'name') : undefined
  const name = typeof rawName === 'string' && /^(?:[A-Za-z][A-Za-z0-9]*Error|Error)$/.test(rawName) ? rawName : 'Error'
  const fallback = nativeError ? name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() : 'UNEXPECTED_THROW'
  const code = nativeError ? safeCode(dataProperty(error, 'code'), fallback) : fallback
  const failure = nativeError ? dataProperty(error, 'failure') : undefined
  const message = safeText(typeof error === 'string' ? error : dataProperty(error, 'message'))
  const stage = safeText(dataProperty(error, 'stage'), 120)
  // ReviewError 的 message 已含受限 cause 摘要，保持完整且避免重复展开。
  if (nativeError && error instanceof ReviewError) {
    const summary = reviewSummaries.get(error) ?? safeText(dataProperty(error, 'message'), detailLimit)
    return [name, code, summary, ...(stage ? ['阶段：' + stage] : [])].join(' · ')
  }
  const parts = [nativeError ? name + ' · ' + code : code]
  if (failure !== undefined) {
    parts.push(failureDetails(failure as LlmFailure))
    if (message && message !== safeText(dataProperty(failure, 'message'))) parts.push(message)
  } else if (message) parts.push(message)
  else parts.push(nativeError ? '异常未提供可读消息' : '抛出了非 Error 值')
  if (stage) parts.push('阶段：' + stage)
  if (Object.hasOwn(subagentFailures, code)) parts.push(subagentFailures[code])
  const cause = dataProperty(error, 'cause')
  if (cause !== undefined) parts.push('原因：' + describe(cause, depth + 1, seen))
  const errors = dataProperty(error, 'errors')
  if (!types.isProxy(errors) && Array.isArray(errors)) {
    const length = dataProperty(errors, 'length')
    if (typeof length === 'number') {
      for (let index = 0; index < Math.min(length, aggregateLimit); index++) {
        parts.push('成员 ' + (index + 1) + '：' + describe(dataProperty(errors, String(index)), depth + 1, seen))
      }
      if (length > aggregateLimit) parts.push('其余成员已省略')
    }
  }
  return bounded(parts.join(' · '), detailLimit)
}

export function safeErrorMessage(error: unknown): string {
  return bounded(describe(error, 0, new Set()), detailLimit)
}
