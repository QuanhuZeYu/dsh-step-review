/** 原生插件设置入口，通过带修订号的 configForms 原子保存。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { defaults } from '../defaults.js'
import { reviewDefinition } from './review-node.js'
import { ReviewNode } from './ReviewCard.js'
import { RouteEditor } from './RouteEditor.js'
import { RuleEditor } from './RuleEditor.js'
import { ruleIssues, type RuleIssues } from './rule-validation.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import css from './SettingsEditor.module.css'
import type { Rule, StepReviewSettings } from '../types.js'

export const name = 'step-review-settings'
export const inject = ['slots', 'configForms', 'remote', 'remote.session', 'uiConversation']
function validation(value: StepReviewSettings, issues: RuleIssues[]): string {
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 300000) return '审查总期限须在 100–300000 毫秒之间。'
  if (!Number.isInteger(value.maxCorrections) || value.maxCorrections < 0 || value.maxCorrections > 10) return '自动订正次数须在 0–10 之间。'
  if (!Number.isInteger(value.maxResponseBytes) || value.maxResponseBytes < 1024 || value.maxResponseBytes > 16777216) return '响应缓冲上限须在 1024–16777216 字节之间。'
  if (!Number.isInteger(value.maxReviewChars) || value.maxReviewChars < 1000 || value.maxReviewChars > 200000) return '审查材料上限须在 1000–200000 字符之间。'
  for (const [index, rule] of value.rules.entries()) {
    const first = Object.values(issues[index])[0]
    if (first) return (rule.id || '未命名规则') + '：' + first
  }
  return ''
}
function Editor({ ctx, scope, t }: { ctx: Context; scope: ConfigForm<StepReviewSettings> } & PropsLocale<'model'>) {
  const remote = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope))
  const [draft, setDraft] = useState<StepReviewSettings>()
  const [revision, setRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogMessage, setCatalogMessage] = useState('')
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [resetRules, setResetRules] = useState(false)
  const ruleKeys = useRef<string[]>([])
  const newRules = useRef(new Set<string>())
  const resetKeys = () => { ruleKeys.current = []; newRules.current.clear() }
  useEffect(() => {
    if (!dirty && !saving && remote.value && remote.revision !== undefined) { setDraft(structuredClone(remote.value)); setRevision(remote.revision); resetKeys() }
  }, [remote, dirty, saving])
  useEffect(() => {
    let active = true
    setCatalogLoading(true)
    setCatalogMessage('正在读取模型列表…')
    void ctx.remote.session.modelCatalog().then(result => {
      if (!active) return
      if (!result.ok) { setCatalogMessage('模型目录暂不可用，可手动填写已配置的模型标识。'); return }
      setCatalog(result.value)
      setCatalogMessage(result.value.failures.length ? '部分提供方读取失败，可刷新或手动填写。' : '')
    }).catch(() => { if (active) setCatalogMessage('模型列表读取失败，可刷新或手动填写。') }).finally(() => { if (active) setCatalogLoading(false) })
    return () => { active = false }
  }, [ctx, catalogVersion])
  if (remote.status !== 'ready' || !draft) return <p>正在等待逐步骤审查配置；请确认服务端插件已启用。</p>
  const edit = (patch: Partial<StepReviewSettings>) => { setDraft({ ...draft, ...patch }); setDirty(true); setMessage('') }
  const editRule = (index: number, patch: Partial<Rule>) => edit({ rules: draft.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) })
  const issues = draft.rules.map(rule => ruleIssues(rule, draft))
  const error = validation(draft, issues)
  const conflict = dirty && revision !== remote.revision
  const reload = () => { if (remote.value) { setDraft(structuredClone(remote.value)); setRevision(remote.revision); setDirty(false); resetKeys(); setResetRules(false); setMessage('已载入当前配置。') } }
  const save = async () => {
    if (error || conflict || revision === undefined) return
    setSaving(true); setMessage('正在保存…')
    try {
      const accepted = await scope.mutate(Object.entries(draft).map(([key, value]) => ({ op: 'set' as const, path: [key], value })), revision)
      if (accepted) { setDirty(false); setMessage('已保存，后续主模型请求使用新配置。') }
      else setMessage('保存未接受，请检查配置或重新载入后再编辑。')
    } catch (error) { setMessage('保存失败：' + (error instanceof Error ? error.message : String(error))) }
    finally { setSaving(false) }
  }
  const disabled = !remote.writable || saving
  const modelProps = { catalog, loading: catalogLoading, reload: () => setCatalogVersion(v => v + 1), t, disabled }
  const addRule = () => {
    const key = crypto.randomUUID()
    ruleKeys.current.push(key); newRules.current.add(key)
    edit({ rules: [...draft.rules, { id: 'rule-' + key.slice(0, 8), enabled: false, target: 'text', matchMode: 'contains', patterns: [], prompt: '指出文本中的具体问题，并提供局部修改建议。', provider: '', model: '' }] })
  }
  while (ruleKeys.current.length < draft.rules.length) ruleKeys.current.push(crypto.randomUUID())
  return <form className={css.form} onSubmit={event => { event.preventDefault(); void save() }}>
    <header className={css.header}><h2>逐步骤审查</h2><p className={css.hint}>匹配规则后审查本步内容，拒绝时交回原会话订正。</p></header>
    <section className={css.section} aria-label='基本设置'>
      <h3>基本设置</h3>
      <div className={css.switchRow}><div className={css.switchText}><span>启用审查</span><p className={css.hint}>通过后发布回复并执行工具。</p></div>
        <Switch checked={draft.enabled} disabled={disabled} label='启用审查' onChange={enabled => edit({ enabled })} /></div>
      <RouteEditor {...modelProps} provider={draft.provider} model={draft.model} reasoningEffort={draft.reasoningEffort}
        onChange={(provider, model, reasoningEffort) => edit({ provider, model, reasoningEffort })} />
      <div className={css.actions}><Button size='sm' disabled={catalogLoading || saving} onClick={() => setCatalogVersion(v => v + 1)}>刷新模型列表</Button><span className={css.hint} role='status'>{catalogMessage}</span></div>
    </section>
    <section className={css.section} aria-label='审查规则'>
      <div className={css.sectionHeader}><div className={css.header}><h3>审查规则</h3><p className={css.hint}>展开规则以编辑匹配条件、提示词和审查模型。</p></div><Button variant='outline' size='sm' disabled={disabled || draft.rules.length >= 16} onClick={addRule}>添加规则</Button></div>
      {!draft.rules.length && <p className={css.hint}>尚未添加规则。添加规则后启用审查。</p>}
      <div className={css.rules}>{draft.rules.map((rule, index) => <RuleEditor key={ruleKeys.current[index]} rule={rule} disabled={disabled} issues={issues[index]}
        defaultOpen={newRules.current.has(ruleKeys.current[index])} onChange={patch => editRule(index, patch)}
        onRemove={() => { ruleKeys.current.splice(index, 1); edit({ rules: draft.rules.filter((_, i) => i !== index) }) }}
        modelProps={{ ...modelProps, fallback: { provider: draft.provider, model: draft.model, reasoningEffort: draft.reasoningEffort || undefined } }} />)}</div>
      <div className={css.actions}>{resetRules ? <><span className={css.hint}>用默认规则替换当前规则？保存后生效。</span><Button size='sm' disabled={disabled} onClick={() => setResetRules(false)}>取消</Button>
        <Button size='sm' variant='outline' disabled={disabled} onClick={() => { resetKeys(); edit({ rules: structuredClone(defaults.rules) }); setResetRules(false) }}>确认载入</Button></>
        : <Button size='sm' disabled={disabled} onClick={() => setResetRules(true)}>载入默认规则</Button>}</div>
    </section>
    <section className={css.section} aria-label='高级设置'>
      <SettingsDisclosure title='高级设置'>
        <div className={css.columns}>
          <label className={css.field}><span>审查超时（毫秒）</span><Input className={css.input} disabled={disabled} type='number' min={100} max={300000} step={1} value={draft.timeoutMs} onChange={event => edit({ timeoutMs: event.target.valueAsNumber })} /></label>
          <label className={css.field}><span>单步骤自动订正次数</span><Input className={css.input} disabled={disabled} type='number' min={0} max={10} step={1} value={draft.maxCorrections} onChange={event => edit({ maxCorrections: event.target.valueAsNumber })} /></label>
        </div>
        <div className={css.switchRow}><div className={css.switchText}><span>提供最近一条用户请求</span><p className={css.hint}>向审查器补充本次任务的上下文。</p></div><Switch checked={draft.includeUserRequest} disabled={disabled} label='提供最近一条用户请求' onChange={includeUserRequest => edit({ includeUserRequest })} /></div>
        <div className={css.columns}>
          <label className={css.field}><span>响应缓冲上限（字节）</span><Input className={css.input} disabled={disabled} type='number' min={1024} max={16777216} step={1} value={draft.maxResponseBytes} onChange={event => edit({ maxResponseBytes: event.target.valueAsNumber })} /></label>
          <label className={css.field}><span>审查材料上限（字符）</span><Input className={css.input} disabled={disabled} type='number' min={1000} max={200000} step={1} value={draft.maxReviewChars} onChange={event => edit({ maxReviewChars: event.target.valueAsNumber })} /></label>
        </div>
      </SettingsDisclosure>
    </section>
    <div className={css.feedback}>
      {error && <p className={css.error} role='alert'>{error}</p>}
      {conflict && <p className={css.error} role='alert'>配置已在其他位置更新。请重新载入后编辑。</p>}
      {!remote.writable && <p className={css.hint}>当前配置为只读。</p>}
      <footer className={css.footer}><span className={css.hint} role='status' aria-live='polite'>{message || (dirty ? '有未保存的更改' : '配置已同步')}</span>
        <div className={css.actions}><Button disabled={saving} onClick={reload}>重新载入</Button><Button type='submit' variant='primary' disabled={!dirty || disabled || Boolean(error) || conflict}>{saving ? '正在保存…' : '保存并生效'}</Button></div></footer>
    </div>
  </form>
}
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.uiConversation.events.register(reviewDefinition))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'step-review', locale: 'conversation' }, ReviewNode))
  const scope = ctx.configForms.get<StepReviewSettings>('step-review')
  const render = ({ t }: PropsLocale<'model'>) => <Editor ctx={ctx} scope={scope} t={t} />
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-step-review', locale: 'model' }, render))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-step-review#step-review', locale: 'model' }, ({ view, t }) => view === 'summary' ? '按机械规则审查模型响应，拒绝后反馈给原会话订正' : render({ t })))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'step-review', label: '逐步骤审查', order: 86, locale: 'model' }, render))
}