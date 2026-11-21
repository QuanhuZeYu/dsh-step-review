/** 规则列表先展示摘要，展开后编辑匹配条件和审查内容。 */
import { useId, useState, type ComponentProps } from 'react'
import { Button, Input, Switch, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Rule } from '../types.js'
import { RouteEditor } from './RouteEditor.js'
import { SettingsSelect } from './SettingsSelect.js'
import type { RuleIssues } from './rule-validation.js'
import css from './SettingsEditor.module.css'
type Props = {
  rule: Rule; disabled: boolean; defaultOpen?: boolean; issues: RuleIssues
  onChange: (patch: Partial<Rule>) => void; onRemove: () => void
  modelProps: Omit<ComponentProps<typeof RouteEditor>, 'provider' | 'model' | 'reasoningEffort' | 'onChange'>
}
const targets = [{ value: 'text' as const, label: '用户可见文本' }, { value: 'tools' as const, label: '工具名与参数' }, { value: 'all' as const, label: '文本和工具参数' }]
const modes = [{ value: 'contains' as const, label: '包含任一词语' }, { value: 'regex' as const, label: '匹配任一正则' }, { value: 'always' as const, label: '始终审查' }]
export function RuleEditor({ rule, disabled, onChange, onRemove, modelProps, issues, defaultOpen = false }: Props) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const firstIssue = Object.values(issues)[0]
  const patternHint = rule.matchMode === 'always' ? '每步审查' : (rule.matchMode === 'regex' ? '正则匹配' : '词语匹配') + ' · ' + rule.patterns.filter(value => value.trim()).length + ' 条'
  return <section className={css.rule} data-invalid={Boolean(firstIssue)} aria-label={rule.id || '未命名规则'} data-review-rule>
    <div className={css.ruleHeader}>
      <Button className={css.ruleToggle} aria-expanded={open} aria-controls={id} aria-describedby={!open && firstIssue ? id + '-summary-error' : undefined} onClick={() => setOpen(value => !value)}>
        <span className={css.ruleTitle}><span className={css.ruleName}>{rule.id || '未命名规则'}</span>
          <span className={css.hint}>{targets.find(item => item.value === rule.target)?.label} · {patternHint}</span></span>
        <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : css.chevron} />
      </Button>
      <Switch checked={rule.enabled} disabled={disabled} label={'启用规则 ' + (rule.id || '未命名规则')} onChange={enabled => onChange({ enabled })} />
    </div>
    {!open && firstIssue && <p id={id + '-summary-error'} className={css.ruleError}>{firstIssue}</p>}
    <div hidden={!open} id={id} role='region' aria-label={'编辑规则 ' + (rule.id || '未命名规则')}>
      <div className={css.ruleBody}>
        <div className={css.field}>
          <label htmlFor={id + '-name'}>规则名称</label>
          <Input id={id + '-name'} className={css.input} value={rule.id} maxLength={80} disabled={disabled}
            aria-invalid={Boolean(issues.id)} aria-describedby={issues.id ? id + '-name-error' : undefined}
            onChange={event => onChange({ id: event.target.value })} />
          {issues.id && <p id={id + '-name-error'} className={css.error}>{issues.id}</p>}
        </div>
        <div className={css.columns}>
          <SettingsSelect label='检查对象' disabled={disabled} value={rule.target} onChange={target => onChange({ target })} options={targets} />
          <SettingsSelect label='匹配方式' disabled={disabled} value={rule.matchMode} onChange={matchMode => onChange({ matchMode })} options={modes} />
        </div>
        {(rule.matchMode !== 'always' || issues.patterns) && <div className={css.field}>
          <label htmlFor={id + '-patterns'}>匹配模式</label>
          <textarea id={id + '-patterns'} className={css.textarea} rows={3} value={rule.patterns.join('\n')} disabled={disabled}
            aria-invalid={Boolean(issues.patterns)} aria-describedby={id + '-patterns-hint'}
            onChange={event => onChange({ patterns: event.target.value.split('\n') })} />
          <p id={id + '-patterns-hint'} className={issues.patterns ? css.error : css.hint}>{issues.patterns || '每行一条，忽略大小写。'}</p>
        </div>}
        <div className={css.field}>
          <label htmlFor={id + '-prompt'}>审查提示词</label>
          <textarea id={id + '-prompt'} className={css.textarea} rows={5} maxLength={12000} disabled={disabled}
            aria-invalid={Boolean(issues.prompt)} aria-describedby={issues.prompt ? id + '-prompt-error' : undefined}
            value={rule.prompt} onChange={event => onChange({ prompt: event.target.value })} />
          {issues.prompt && <p id={id + '-prompt-error'} className={css.error}>{issues.prompt}</p>}
        </div>
        <RouteEditor {...modelProps} provider={rule.provider} model={rule.model} reasoningEffort={rule.reasoningEffort}
          onChange={(provider, model, reasoningEffort) => onChange({ provider, model, reasoningEffort })} />
        {issues.model && <p className={css.error}>{issues.model}</p>}
        <div className={css.ruleActions}>
          {confirmRemove ? <><span className={css.hint}>删除这条规则？保存后生效。</span><Button size='sm' disabled={disabled} onClick={() => setConfirmRemove(false)}>取消</Button>
            <Button className={css.danger} size='sm' disabled={disabled} onClick={onRemove}>确认删除</Button></>
            : <Button className={css.danger} size='sm' disabled={disabled} onClick={() => setConfirmRemove(true)}>删除规则</Button>}
        </div>
      </div>
    </div>
  </section>
}
