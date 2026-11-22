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
    id: 'release-body', enabled: true, target: 'tools', matchMode: 'regex',
    patterns: [
      "gh(?:[.]exe)?[\\s\\S]{0,240}?release[\\s\\S]{0,80}?(?:create|edit)",
      "(?:api[.]github[.]com|gh(?:[.]exe)?[\\s\\S]{0,80}?api)[\\s\\S]{0,320}?/releases(?:[/][0-9]+)?[\\s\\S]{0,800}?(?:body|input)",
      "(?:body|input)[\\s\\S]{0,800}?(?:api[.]github[.]com|gh(?:[.]exe)?[\\s\\S]{0,80}?api)[\\s\\S]{0,320}?/releases",
      "(?:/repos/[^/\\s\"']+/[^/\\s\"']+/releases|(?:repos|releases)[.](?:create|update)Release)[\\s\\S]{0,800}?body",
      "body[\\s\\S]{0,800}?(?:/repos/[^/\\s\"']+/[^/\\s\"']+/releases|(?:repos|releases)[.](?:create|update)Release)",
      "(?:write|edit|patch|writeFile|write_text|Set-Content|Out-File)[\\s\\S]{0,320}?(?:release(?:[-_ ]?(?:notes?|body))?|releases?[/\\\\][^\"'\\s]*)[^\"'\\r\\n]{0,100}[.](?:md|txt|markdown)",
      "(?:release(?:[-_ ]?(?:notes?|body))?|releases?[/\\\\][^\"'\\s]*)[^\"'\\r\\n]{0,100}[.](?:md|txt|markdown)[\\s\\S]{0,160}?(?:write|edit|patch|>)",
    ],
    prompt: '仅审查实际发布或准备的Release正文；开发材料中的示例直接通过。正文面向用户，保留产品变化、兼容性、限制和校验方法，拒绝测试、构建、评审等开发过程汇报。引用文件须读取实际待发布内容；缺失或不可读则拒绝。同一步先写后发须拆开，旧文件不能证明新正文。拒绝时给出具体问题和局部建议。',
    provider: '', model: '', reasoningEffort: '',
  },
  {
    id: 'clear-writing', enabled: true, target: 'text', matchMode: 'contains',
    patterns: ['不代表', '不等于', '并不意味着', '并不代表', '这不是', '而不是', '按照要求', '按要求', '无对应 issue', '没有修改', '保持不变', '免责声明', '综上所述', '总而言之', '值得注意的是'],
    prompt: '检查面向用户的文本。仅当自我表态、合规复述、无关否定、重复解释或空泛结尾妨碍理解、决定或行动时拒绝，指出具体片段和影响，建议局部删除。保留必要事实、术语、引用、失败、限制和恢复方法。关键词只是触发信号，个人偏好与假想异议不构成拒绝理由。',
    provider: '', model: '', reasoningEffort: '',
  },
  {
    id: 'evidence-alignment', enabled: true, target: 'text', matchMode: 'contains',
    patterns: ['已完成', '已修复', '已解决', '已生效', '已上线', '已经完成', '已经修复', '全部通过', '验证通过', '构建通过', '测试通过', '可以使用', '可直接使用', '已可用'],
    prompt: '检查完成、修复、可用、生效等结论与给定证据及验证范围是否一致。仅在材料中存在具体矛盾或明确扩大结论会误导使用时拒绝，指出片段与影响并建议准确表述。未附主会话、构建或运行记录不构成矛盾，不自行遍历项目、Git 和旧验收来证明每句结论；无具体问题直接通过。',
    provider: '', model: '', reasoningEffort: '',
  },
  {
    id: 'synthesized-delivery', enabled: true, target: 'text', matchMode: 'contains',
    patterns: ['子代理', '子智能体', '子 Agent', '子Agent', 'subagent', '代理报告', '协作报告', '评审报告', '交付报告', '协调记录', '收到汇报'],
    prompt: '检查面向用户的交付是否给出综合后的结果、判断、关键依据和必要后续行动。仅当协调流水账、重复回执或原样转贴报告妨碍获取结果时拒绝，指出具体片段与影响并建议局部整理。保留必要出处、失败与限制；用户要求的原始记录、审计材料和开发日志可直接通过。',
    provider: '', model: '', reasoningEffort: '',
  },
]
export const defaults: StepReviewSettings = {
  enabled: false, provider: '', model: '', reasoningEffort: '', reviewerPreset: 'step-review-reader',
  timeoutMs: 120000, maxReviewSteps: 12, maxCorrections: 3,
  includeUserRequest: false,
  rules: defaultRules,
}
