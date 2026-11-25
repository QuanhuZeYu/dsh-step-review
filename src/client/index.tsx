/** 原生插件设置入口，通过带修订号的 configForms 原子保存。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { defaults } from '../defaults.js'
import { maxTimeoutMs } from '../settings-limits.js'
import { reviewDefinition } from './review-node.js'
import { ReviewNode } from './ReviewCard.js'
import { ReviewSessionDialog, type ReviewSessionTarget } from './ReviewSessionDialog.js'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { registerReviewCatalog } from './ReviewCatalog.js'
import { registerCatalogSidebar } from './catalog-sidebar.js'
import { RouteEditor } from './RouteEditor.js'
import { RuleEditor } from './RuleEditor.js'
import { ruleIssues, type RuleIssues } from './rule-validation.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import css from './SettingsEditor.module.css'
import type { Rule, StepReviewSettings } from '../types.js'

export const name = 'step-review-settings'
export const inject = ['slots', 'configForms', 'settingsSchema', 'remote', 'remote.session', 'uiConversation', 'sessions', 'workspaces', 'uiWorkspace']
// 新客户端可能先于服务端模块更新，旧描述不会包含新增字段。
type OptionalSettings = 'reviewerPreset' | 'maxReviewSteps' | 'maxConcurrentReviews' | 'stopOnEvidenceChange'
type SettingsFormValue = Omit<StepReviewSettings, OptionalSettings> & Partial<Pick<StepReviewSettings, OptionalSettings>>

function formValue(value: SettingsFormValue): StepReviewSettings {
  const current = Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(defaults, key)))
  return structuredClone({ ...defaults, ...current, reviewerPreset: value.reviewerPreset ?? defaults.reviewerPreset,
    maxReviewSteps: value.maxReviewSteps ?? defaults.maxReviewSteps, maxConcurrentReviews: value.maxConcurrentReviews ?? defaults.maxConcurrentReviews,
    stopOnEvidenceChange: value.stopOnEvidenceChange ?? defaults.stopOnEvidenceChange })
}
function validation(value: SettingsFormValue, issues: RuleIssues[]): string {
  if (value.reviewerPreset !== defaults.reviewerPreset) return '审查 Agent 仅支持 step-review-reader。'
  for (const [index, rule] of value.rules.entries()) {
    const first = Object.values(issues[index])[0]
    if (first) return (rule.id || '未命名规则') + '：' + first
  }
  return ''
}
function Editor({ ctx, scope, t }: { ctx: Context; scope: ConfigForm<SettingsFormValue> } & PropsLocale<'model'>) {
  const remote = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope))
  const mirror = ctx.configForms.describe()
  const description = useSyncExternalStore(mirror.subscribe.bind(mirror), mirror.getSnapshot.bind(mirror), mirror.getSnapshot.bind(mirror))
  const namespace = description.view?.namespaces.find(item => item.ns === 'step-review')
  const schema = useMemo(() => namespace ? ctx.settingsSchema.rehydrate(namespace.schema) : undefined, [ctx, namespace?.schema])
  const [draft, setDraft] = useState<SettingsFormValue>()
  const [revision, setRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogMessage, setCatalogMessage] = useState('')
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [presetMessage, setPresetMessage] = useState('正在读取 preset 目录…')
  const [resetRules, setResetRules] = useState(false)
  const ruleKeys = useRef<string[]>([])
  const newRules = useRef(new Set<string>())
  const resetKeys = () => { ruleKeys.current = []; newRules.current.clear() }
  useEffect(() => {
    if (!dirty && !saving && remote.value && remote.revision !== undefined) { setDraft(formValue(remote.value)); setRevision(remote.revision); resetKeys() }
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
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => ctx.remote.agentPresets.list()).then(result => {
      if (!active) return
      if (!result.ok) { setPresetMessage('preset 目录暂不可用，审查仅使用 step-review-reader。'); return }
      setPresetMessage(result.value.presets.some(item => item.id === defaults.reviewerPreset && !item.broken)
        ? '已找到逐步骤只读审查 preset。' : '目录中未找到可用的 step-review-reader，请重新加载服务端插件。')
    }).catch(() => { if (active) setPresetMessage('preset 目录读取失败，审查仅使用 step-review-reader。') })
    return () => { active = false }
  }, [ctx, catalogVersion])
  if (remote.status !== 'ready' || !draft) return <p>正在等待逐步骤审查配置；请确认服务端插件已启用。</p>
  const edit = (patch: Partial<StepReviewSettings>) => { setDraft({ ...draft, ...patch }); setDirty(true); setMessage('') }
  const editRule = (index: number, patch: Partial<Rule>) => edit({ rules: draft.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) })
  const issues = draft.rules.map(rule => ruleIssues(rule, draft))
  const schemaError = schema ? ctx.settingsSchema.validate(schema, draft) : undefined
  const error = validation(draft, issues) || (schemaError ? '配置校验失败：' + schemaError : '')
  const conflict = dirty && revision !== remote.revision
  const reload = () => { if (remote.value) { setDraft(formValue(remote.value)); setRevision(remote.revision); setDirty(false); resetKeys(); setResetRules(false); setMessage('已载入当前配置。') } }
  const save = async (disableReview = false) => {
    if (!remote.writable || saving || conflict || revision === undefined || !remote.value) return
    if (!disableReview && (error || !schema)) return
    setSaving(true); setMessage('正在保存…')
    try {
      const baseline = formValue(remote.value)
      // 关闭只写启用状态，坏规则、preset 和其他草稿不参与本次保存。
      const changed = disableReview ? [['enabled', false] as const] : Object.entries(draft).filter(([key, value]) => Object.hasOwn(defaults, key)
        && JSON.stringify(value) !== JSON.stringify(baseline[key as keyof StepReviewSettings]))
      const unsupported = !disableReview && changed.find(([key]) => !ctx.settingsSchema.nodeAtPath(schema!, [key]))
      if (unsupported) { setMessage('当前服务端尚未支持此设置，请先通过插件管理器加载新版插件后再保存。'); return }
      if (!changed.length) { setDirty(false); setMessage('配置未发生变化。'); return }
      const ops = changed
        .map(([key, value]) => ({ op: 'set' as const, path: [key], value: Array.isArray(value) ? value.map(rule => ({ ...rule })) : value }))
      const accepted = await scope.mutate(ops, revision)
      if (accepted) { setDirty(false); setMessage(disableReview ? '已关闭审查；其他草稿未保存。' : '已保存，后续主模型请求使用新配置。') }
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
        <Switch checked={draft.enabled} disabled={disabled || conflict} label='启用审查' onChange={enabled => { if (enabled) edit({ enabled }); else void save(true) }} /></div>
      <p className={css.hint}>关闭开关会立即保存关闭状态，其他草稿不保存。</p>
      <label className={css.field}><span>审查 Agent preset id</span>
        <select className={css.input} disabled={disabled} value={draft.reviewerPreset === defaults.reviewerPreset ? defaults.reviewerPreset : ''}
          onChange={event => edit({ reviewerPreset: event.target.value })}>
          <option value='' disabled>选择只读审查 preset</option>
          <option value={defaults.reviewerPreset}>step-review-reader</option>
        </select>
        <span className={css.hint}>{presetMessage} step-review-reader 只读取证；preset 仅决定工具与权限，审查模型在下方单独配置。</span>
      </label>
      <RouteEditor {...modelProps} provider={draft.provider} model={draft.model} reasoningEffort={draft.reasoningEffort}
        onChange={(provider, model, reasoningEffort) => edit({ provider, model, reasoningEffort })} />
      <div className={css.actions}><Button size='sm' disabled={catalogLoading || saving} onClick={() => setCatalogVersion(v => v + 1)}>刷新模型与 preset 目录</Button><span className={css.hint} role='status'>{catalogMessage}</span></div>
    </section>
    <section className={css.section} aria-label='审查规则'>
      <div className={css.sectionHeader}><div className={css.header}><h3>审查规则</h3><p className={css.hint}>展开规则以编辑匹配条件、提示词和审查模型。</p></div><Button variant='outline' size='sm' disabled={disabled} onClick={addRule}>添加规则</Button></div>
      {!draft.rules.length && <p className={css.hint}>尚未添加规则。添加规则后启用审查。</p>}
      <div className={css.rules}>{draft.rules.map((rule, index) => <RuleEditor key={ruleKeys.current[index]} rule={rule} disabled={disabled} issues={issues[index]}
        defaultOpen={newRules.current.has(ruleKeys.current[index])} onChange={patch => editRule(index, patch)}
        onRemove={() => { ruleKeys.current.splice(index, 1); edit({ rules: draft.rules.filter((_, i) => i !== index) }) }}
        modelProps={{ ...modelProps, fallback: { provider: draft.provider, model: draft.model, reasoningEffort: draft.reasoningEffort || undefined } }} />)}</div>
      <div className={css.actions}>{resetRules ? <><span className={css.hint}>用默认规则替换当前规则？保存后生效。</span><Button size='sm' disabled={disabled} onClick={() => setResetRules(false)}>取消</Button>
        <Button size='sm' variant='outline' disabled={disabled} onClick={() => { resetKeys(); edit({ rules: structuredClone(defaults.rules) }); setResetRules(false) }}>确认载入</Button></>
        : <Button size='sm' disabled={disabled} onClick={() => setResetRules(true)}>载入默认规则</Button>}</div>
    </section>
    <section className={css.section}>
      <SettingsDisclosure title='高级设置'>
        <div className={css.columns}>
          <label className={css.field}><span>审查超时（毫秒）</span><Input className={css.input} disabled={disabled} type='number' min={1} max={maxTimeoutMs} step={1} value={draft.timeoutMs} onChange={event => edit({ timeoutMs: event.target.valueAsNumber })} /></label>
          <label className={css.field}><span>单次审查 Agent 步骤上限</span><Input className={css.input} disabled={disabled} type='number' min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.maxReviewSteps ?? defaults.maxReviewSteps} onChange={event => edit({ maxReviewSteps: event.target.valueAsNumber })} /></label>
          <label className={css.field}><span>审查并发上限</span><Input className={css.input} disabled={disabled} type='number' min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.maxConcurrentReviews ?? defaults.maxConcurrentReviews} onChange={event => edit({ maxConcurrentReviews: event.target.valueAsNumber })} /></label>
          <label className={css.field}><span>单步骤自动订正次数</span><Input className={css.input} disabled={disabled} type='number' min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.maxCorrections} onChange={event => edit({ maxCorrections: event.target.valueAsNumber })} /></label>
        </div>
        <p className={css.hint}>审查使用独立容量池，默认最多并发 16 个，与工作 Agent 分开计数。保存后后续接纳使用新容量；已运行的审查继续占用名额直至结束。</p>
        <p className={css.hint}>审查输出沿用所选模型的原生设置，材料与取证结果按原生工具行为提供。</p>
        <div className={css.switchRow}><div className={css.switchText}><span>取证文件变化时中止</span><p className={css.hint}>默认关闭，按审查时读取的证据继续。开启后，放行前复核文件版本，变化或消失时停止本次响应。</p></div><Switch checked={draft.stopOnEvidenceChange ?? defaults.stopOnEvidenceChange} disabled={disabled} label='取证文件变化时中止' onChange={stopOnEvidenceChange => edit({ stopOnEvidenceChange })} /></div>
        <div className={css.switchRow}><div className={css.switchText}><span>提供最近一条用户请求</span><p className={css.hint}>向审查器补充本次任务的上下文。</p></div><Switch checked={draft.includeUserRequest} disabled={disabled} label='提供最近一条用户请求' onChange={includeUserRequest => edit({ includeUserRequest })} /></div>
      </SettingsDisclosure>
    </section>
    <div className={css.feedback}>
      {error && <p className={css.error} role='alert'>{error}</p>}
      {conflict && <p className={css.error} role='alert'>配置已在其他位置更新。请重新载入后编辑。</p>}
      {!remote.writable && <p className={css.hint}>当前配置为只读。</p>}
      <footer className={css.footer}><span className={css.hint} role='status' aria-live='polite'>{message || (dirty ? '有未保存的更改' : '配置已同步')}</span>
        <div className={css.actions}><Button disabled={saving} onClick={reload}>放弃草稿并载入当前配置</Button><Button type='submit' variant='primary' disabled={!schema || !dirty || disabled || Boolean(error) || conflict}>{saving ? '正在保存…' : '保存并生效'}</Button></div></footer>
    </div>
  </form>
}
export function apply(ctx: Context): void {
  registerReviewCatalog(ctx)
  registerCatalogSidebar(ctx)
  ctx.effect(() => ctx.uiConversation.events.register(reviewDefinition))
  const selected = createSnapshotStore<{ parentSessionId: SessionId; target: ReviewSessionTarget } | null>(null)
  function ReviewOverlay({ t }: PropsLocale<'conversation'>) {
    const selection = useSyncExternalStore(selected.subscribe, selected.getSnapshot)
    return selection && <ReviewSessionDialog {...selection} t={t} close={() => selected.set(null)} />
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'step-review.session', locale: 'conversation' }, ReviewOverlay))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'step-review', locale: 'conversation',
    inject: (parentSessionId: SessionId) => ({
      openReview: (target: ReviewSessionTarget) => {
        if ('id' in target && !target.id.startsWith('step-review-detail-')) ctx.uiWorkspace.openSession(target.id as SessionId)
        else selected.set({ parentSessionId: 'id' in target && target.originSessionId
          ? target.originSessionId as SessionId : parentSessionId, target })
      },
    }),
  }, ReviewNode))
  const scope = ctx.configForms.get<SettingsFormValue>('step-review')
  const render = ({ t }: PropsLocale<'model'>) => <Editor ctx={ctx} scope={scope} t={t} />
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-step-review', locale: 'model' }, render))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-step-review#step-review', locale: 'model' }, ({ view, t }) => view === 'summary' ? '按机械规则审查模型响应，拒绝后反馈给原会话订正' : render({ t })))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'step-review', label: '逐步骤审查', order: 86, locale: 'model' }, render))
}