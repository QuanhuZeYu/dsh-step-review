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
    ],
    prompt: '先判断本步是否实际执行 GitHub Release 的创建或正文更新（gh release create/edit 或等价 API 写操作）。匹配词仅为触发信号；仅讨论、引用命令，读取或审阅正文，写入草稿，构建、打包、生成校验和及检查附件的准备步骤，直接通过，不要求尚未执行的工具先产出文件，也不扩大为整个发布流程审查。实际发布时，只审查本次提交的 Release 正文：面向用户保留产品变化、兼容性、限制与校验方法，拒绝无关的测试、构建、评审过程汇报。正文直接给在参数中就审查该文本；通过 notes-file 等文件参数引用正文时须读取对应落盘文件，缺失或不可读才拒绝。同一步写入正文文件并实际发布时要求拆步；该要求不适用于单纯准备或评审。上传附件、只改标题或元数据而未提交正文时不审正文。拒绝须指出具体正文问题或实际发布所需文件缺口及局部建议。',
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
    prompt: '只检查给定材料中完成、修复、可用、生效等结论是否存在具体矛盾，或把明确有限的验证外推为更广的结论。先定位一处具体冲突；找不到就立即调用 structured_output 返回 pass，reason 简述无具体矛盾，suggestions 为空。缺少主会话、构建或运行记录不构成冲突，不调用工具寻找缺失背景，不逐句证明结论，不为可选措辞反复权衡。存在具体冲突时返回 reject，简述冲突片段、影响和局部修改建议。不重复整段候选，不提出与拒绝无关的建议；最终裁决必须是 structured_output 工具调用，不能把 JSON 当作普通文本输出。',
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
  timeoutMs: 120000, maxReviewSteps: 12, maxConcurrentReviews: 16, maxCorrections: 3,
  includeUserRequest: false,
  rules: defaultRules,
}
