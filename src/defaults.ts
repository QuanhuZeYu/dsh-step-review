import type { Rule, StepReviewSettings } from './types.js'

/** 提示词只约束审查对象，修订由原会话完成。 */
export const defaultRules: Rule[] = [
  {
    id: 'commit-message', enabled: true, target: 'tools', matchMode: 'regex',
    patterns: ['git(?:[.]exe)?[\\s\\S]{0,240}?commit', '["\']commit["\']'],
    prompt: '审查本次 Git 提交说明。面向未参与原始对话的读者，检查是否夹带无关的对话约束、自我表态或无关否定，例如“无对应 issue”“按要求没有修改某模块”。以实际变化为核心。必要的兼容性、故障及验证状态应保留。若工具参数未包含提交说明正文，返回 pass；不要猜测未提供的文件内容。只给拒绝原因和局部修改建议，由原会话订正。',
    provider: '', model: '', reasoningEffort: '',
  },
  {
    id: 'clear-writing', enabled: true, target: 'text', matchMode: 'contains',
    patterns: ['不代表', '不等于', '并不意味着', '并不代表', '这不是', '而不是', '按照要求', '无对应 issue'],
    prompt: '检查面向用户的文本是否包含无帮助的限定、约束复述或绕行表达。优先直接表达结果、原因和状态。关键词只是触发信号，技术上的必要区分和影响读者判断的真实限制应保留。只有能指出具体冗余或难读句子时才拒绝，给出问题片段、原因和精简建议。保留必要事实、术语、引用和验证状态；由原会话完成修订。',
    provider: '', model: '', reasoningEffort: '',
  },
]
export const reviewTokenLimit = 65_536

export const defaults: StepReviewSettings = {
  enabled: false, provider: '', model: '', reasoningEffort: '', timeoutMs: 30000, maxCorrections: 3,
  maxReviewTokens: 16_384,
  maxResponseBytes: 2097152, maxReviewChars: 48000, includeUserRequest: false,
  rules: defaultRules,
}
