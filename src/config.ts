import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { defaults } from './defaults.js'
import type { StepReviewSettings } from './types.js'

/** Loader 的 live 引用，单次主请求开始时读取快照。 */
export type LiveConfig = { [K in keyof StepReviewSettings]-?: Volatile<StepReviewSettings[K]> }
const rule = z.object({
  id: z.string().min(1).max(80).required(), enabled: z.boolean().default(true),
  target: z.union(['text', 'tools', 'all']).required(), matchMode: z.union(['contains', 'regex', 'always']).required(),
  patterns: z.array(z.string().max(512)).max(32).default([]),
  prompt: z.string().min(1).max(12000).required(),
  provider: z.string().max(200).default(''), model: z.string().max(200).default(''),
  reasoningEffort: z.union([z.string().max(200), z.const(null)]),
})
export const Config = z.object({
  enabled: z.boolean().default(defaults.enabled).description('启用逐步骤审查').volatile(),
  provider: z.string().max(200).default('').description('审查模型 provider id').volatile(),
  model: z.string().max(200).default('').description('审查模型 id').volatile(),
  reasoningEffort: z.union([z.string().max(200), z.const(null)]).description('审查模型推理等级，留空使用提供方默认值').volatile(),
  reviewerPreset: z.string().min(1).max(200).default(defaults.reviewerPreset).description('审查 Agent preset id').volatile(),
  timeoutMs: z.number().step(1).min(100).max(300000).default(defaults.timeoutMs).description('单次审查 Agent 的总期限（毫秒）').volatile(),
  maxReviewSteps: z.number().step(1).min(1).max(64).default(defaults.maxReviewSteps).description('单次审查 Agent 的步骤上限').volatile(),
  maxCorrections: z.number().step(1).min(0).max(10).default(defaults.maxCorrections).description('单步骤自动订正次数').volatile(),
  includeUserRequest: z.boolean().default(false).description('向审查器提供最近一条完整用户请求').volatile(),
  rules: z.array(rule).max(16).default(defaults.rules).description('机械匹配与审查规则').volatile(),
})
export function snapshot(config: LiveConfig): StepReviewSettings {
  // Schema 会保留未知旧键；只读取当前契约中的可变引用。
  const keys = Object.keys(defaults) as (keyof StepReviewSettings)[]
  const value = Object.fromEntries(keys.map(key => [key, config[key].get()])) as unknown as StepReviewSettings
  return structuredClone({ ...value, reasoningEffort: value.reasoningEffort === undefined ? '' : value.reasoningEffort,
    rules: value.rules.map(rule => ({ ...rule, reasoningEffort: rule.reasoningEffort === undefined ? '' : rule.reasoningEffort })) })
}
