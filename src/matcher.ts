import { Worker } from 'node:worker_threads'
import type { Candidate, Rule } from './types.js'
import { ReviewError } from './failure.js'

/** 正则匹配在独立 worker 中运行，异常及超时阻止候选放行。 */
function regexMatches(patterns: string[], subject: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      'const {parentPort,workerData}=require("node:worker_threads");try{parentPort.postMessage({match:workerData.patterns.some(p=>new RegExp(p,"iu").test(workerData.subject))})}catch(e){parentPort.postMessage({error:e.message})}',
      { eval: true, workerData: { patterns, subject }, resourceLimits: { maxOldGenerationSizeMb: 64 } },
    )
    let settled = false
    const finish = (error?: Error, match = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error); else resolve(match)
    }
    const abort = () => finish(new ReviewError('规则匹配已取消'))
    const timer = setTimeout(() => finish(new ReviewError('规则正则匹配超过期限')), 1000)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (result: { match?: boolean; error?: string }) => finish(result.error ? new ReviewError('规则正则表达式无效') : undefined, result.match))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!settled) finish(new ReviewError('规则匹配 worker 提前退出：' + code)) })
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
  for (const rule of rules) {
    signal.throwIfAborted()
    if (ids.has(rule.id)) throw new ReviewError('规则 id 重复：' + rule.id)
    ids.add(rule.id)
    if (!rule.enabled) continue
    const subject = subjectFor(rule, candidate)
    if (rule.target === 'text' && !candidate.text.trim()) continue
    if (rule.target === 'tools' && candidate.tools.length === 0) continue
    if (rule.matchMode === 'always' || (rule.matchMode === 'contains'
      ? rule.patterns.some(pattern => pattern.length > 0 && subject.toLocaleLowerCase().includes(pattern.toLocaleLowerCase()))
      : await regexMatches(rule.patterns, subject, signal))) matched.push(rule)
  }
  return matched
}
