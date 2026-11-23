/** 列表摘要和编辑区共用规则校验，保存前使用相同结果。 */
import type { Rule, StepReviewSettings } from '../types.js'
export interface RuleIssues { id?: string; prompt?: string; patterns?: string; model?: string }
export function ruleIssues(rule: Rule, settings: Pick<StepReviewSettings, 'enabled' | 'provider' | 'model' | 'rules'>): RuleIssues {
  const issues: RuleIssues = {}
  if (!rule.id.trim()) issues.id = '填写规则名称。'
  else if (settings.rules.filter(item => item.id === rule.id).length > 1) issues.id = '规则名称与其他规则重复。'
  if (!rule.prompt.trim()) issues.prompt = '填写审查提示词。'
  if (rule.matchMode !== 'always') {
    if (rule.enabled && !rule.patterns.some(pattern => pattern.trim())) issues.patterns = '启用规则前至少填写一条匹配模式。'
    if (rule.enabled && rule.matchMode === 'regex') {
      for (const [index, pattern] of rule.patterns.entries()) {
        try {
          // 与 Host 匹配器的 Unicode、不区分大小写语法一致。
          new RegExp(pattern, 'iu')
        } catch {
          issues.patterns = '第 ' + (index + 1) + ' 行不是有效的正则表达式。'
          break
        }
      }
    }
  }
  if (settings.enabled && rule.enabled && (!(rule.provider.trim() || settings.provider.trim()) || !(rule.model.trim() || settings.model.trim()))) issues.model = '选择完整的审查模型，或在默认设置中补齐 Provider 和 Model；preset 仅决定工具与权限。'
  return issues
}
