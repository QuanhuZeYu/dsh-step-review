import { Worker } from 'node:worker_threads'
import type { Candidate, Rule } from './types.js'
import { ReviewError } from './failure.js'

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new ReviewError('规则匹配已取消', { code: 'STEP_REVIEW_MATCH_CANCELLED', stage: 'matcher', cause: signal.reason })
}

/** 正则 worker 仅执行内置代码，不继承宿主的模块模式、调试器或加载器参数。 */
function regexMatches(patterns: string[], subject: string, signal: AbortSignal, ruleId: string): Promise<boolean> {
  checkSignal(signal)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(
        'const {parentPort,workerData}=require("node:worker_threads");let index=-1;try{const patterns=workerData.patterns.map((p,i)=>{index=i;return new RegExp(p,"iu")});index=-1;parentPort.postMessage({match:patterns.some(p=>p.test(workerData.subject))})}catch(e){parentPort.postMessage({error:true,index})}',
        { eval: true, execArgv: [], workerData: { patterns, subject }, resourceLimits: { maxOldGenerationSizeMb: 64 } },
      )
    } catch (cause) {
      reject(new ReviewError('正则匹配 worker 无法启动，请核对 Node.js 运行环境', { code: 'STEP_REVIEW_REGEX_WORKER_START', stage: 'matcher', cause }))
      return
    }
    let settled = false
    const finish = (error?: Error, match = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // 终止在所有结算路径执行，避免超时或取消后继续消耗 CPU。
      void worker.terminate().catch(() => {})
      if (error) reject(error); else resolve(match)
    }
    const abort = () => finish(new ReviewError('规则匹配已取消', { code: 'STEP_REVIEW_MATCH_CANCELLED', stage: 'matcher', cause: signal.reason }))
    const timer = setTimeout(() => finish(new ReviewError('规则正则匹配超过期限（1000 毫秒）', { code: 'STEP_REVIEW_REGEX_TIMEOUT', stage: 'matcher' })), 1000)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (result: { match?: boolean; error?: boolean; index?: number }) => finish(result.error
      ? new ReviewError('规则 ' + ruleId + ' 的正则表达式无效' + (Number.isInteger(result.index) && result.index! >= 0 ? '：第 ' + (result.index! + 1) + ' 条模式' : ''),
        { code: 'STEP_REVIEW_REGEX_INVALID', stage: 'matcher' }) : undefined, result.match))
    worker.once('error', cause => finish(new ReviewError('正则匹配 worker 启动或执行失败，请核对 Node.js 运行环境', { code: 'STEP_REVIEW_REGEX_WORKER_ERROR', stage: 'matcher', cause })))
    worker.once('exit', code => { if (!settled) finish(new ReviewError('规则匹配 worker 提前退出：' + code, { code: 'STEP_REVIEW_REGEX_WORKER_EXIT', stage: 'matcher' })) })
    if (signal.aborted) abort()
  })
}
export function subjectFor(rule: Rule, candidate: Candidate): string {
  if (rule.target === 'text') return candidate.text
  if (rule.target === 'tools') return candidate.tools.map(call => call.name + '\n' + call.arguments).join('\n')
  return JSON.stringify(candidate)
}
export async function matchRules(rules: Rule[], candidate: Candidate, signal: AbortSignal): Promise<Rule[]> {
  const matched: Rule[] = []
  const ids = new Set<string>()
  // 停用规则不占用 id，启用规则统一诊断重复。
  for (const rule of rules) {
    checkSignal(signal)
    if (!rule.enabled) continue
    if (ids.has(rule.id)) throw new ReviewError('启用规则 id 重复：' + rule.id, { code: 'STEP_REVIEW_RULE_DUPLICATE_ID', stage: 'matcher' })
    ids.add(rule.id)
  }
  for (const rule of rules) {
    checkSignal(signal)
    if (!rule.enabled) continue
    const subject = subjectFor(rule, candidate)
    // 编译和匹配都留在受期限约束的 worker，空候选也会诊断坏模式。
    const regexMatch = rule.matchMode === 'regex' ? await regexMatches(rule.patterns, subject, signal, rule.id) : false
    if (rule.target === 'text' && !candidate.text.trim()) continue
    if (rule.target === 'tools' && candidate.tools.length === 0) continue
    if (rule.matchMode === 'always' || (rule.matchMode === 'contains'
      ? rule.patterns.some(pattern => pattern.length > 0 && subject.toLocaleLowerCase().includes(pattern.toLocaleLowerCase()))
      : regexMatch)) matched.push(rule)
  }
  return matched
}
