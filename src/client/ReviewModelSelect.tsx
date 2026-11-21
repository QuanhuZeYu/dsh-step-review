/** 原生两级模型选择器的配置适配；所有选择仅写入配置草稿。 */
import { useMemo, type ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModelSelect } from '@deepseek-ai/dsh-client-ui-model-selection/src/client/ModelSelect.tsx'
import css from './ReviewModelSelect.module.css'
type Props = PropsLocale<'model'> & {
  label: string; provider: string; model: string; reasoningEffort?: string | null
  fallback?: ModelSelection; catalog?: ModelCatalog; loading: boolean; disabled: boolean
  reload: () => void
  onChange: (provider: string, model: string, reasoningEffort: string | null) => void
}
const renderSlot: ComponentProps<typeof ModelSelect>['renderSlot'] = (_name, _owner, options) => options?.fallback ?? null
export function ReviewModelSelect({ label, provider, model, reasoningEffort, fallback, catalog, loading, disabled, reload, onChange, t }: Props) {
  const effectiveProvider = provider.trim() || fallback?.provider.trim() || ''
  const effectiveModel = model.trim() || fallback?.model.trim() || ''
  const hasRouteOverride = Boolean(provider.trim() || model.trim())
  const effort = reasoningEffort === null ? undefined : reasoningEffort?.trim() || (!hasRouteOverride ? fallback?.reasoningEffort?.trim() : undefined)
  const providerName = catalog?.groups.find(group => group.id === effectiveProvider)?.name
  const providerText = providerName && providerName !== effectiveProvider ? providerName + '（' + effectiveProvider + '）' : effectiveProvider
  const directory = useMemo(() => {
    const groups = [...(catalog?.groups ?? [])]
    const found = groups.some(group => group.id === effectiveProvider && group.models.some(item => item.id === effectiveModel))
    // 手动配置的路由保留原名；推理能力只使用真实目录元数据。
    if (effectiveProvider && effectiveModel && !found) {
      const at = groups.findIndex(group => group.id === effectiveProvider)
      const item = { id: effectiveModel, name: effectiveModel }
      if (at < 0) groups.push({ id: effectiveProvider, name: effectiveProvider, models: [item] })
      else groups[at] = { ...groups[at], models: [...groups[at].models, item] }
    }
    return createSnapshotStore<ModelDirectoryState>({
      current: effectiveProvider && effectiveModel ? { provider: effectiveProvider, model: effectiveModel, ...(effort ? { reasoningEffort: effort } : {}) } : null,
      retainedEffort: effort, routable: found, groups, failures: catalog?.failures ?? [],
      status: loading ? 'loading' : 'ready', pending: null, error: null,
    })
  }, [catalog, effectiveProvider, effectiveModel, effort, loading])
  const hasEffortOverride = reasoningEffort === null || Boolean(reasoningEffort?.trim())
  const hasOverride = hasRouteOverride || hasEffortOverride
  const inheritance = fallback
    ? !hasOverride ? '继承默认审查模型与推理等级'
      : !hasRouteOverride ? reasoningEffort === null
        ? '继承默认审查模型，推理等级使用提供方默认'
        : '继承默认审查模型，推理等级单独设置'
        : reasoningEffort?.trim() ? '本规则单独设置模型与推理等级'
          : '本规则单独设置模型，推理等级使用提供方默认'
    : '模型与推理等级用于默认审查'
  return <div className={css.field} data-review-model-field>
    <div className={css.header}>
      <span className={css.label}>{label}</span>
      {fallback && hasOverride && <Button className={css.reset} size='sm' variant='ghost' disabled={disabled}
        onClick={() => onChange('', '', '')}>恢复默认</Button>}
    </div>
    <div className={css.control} role='group' aria-label={label}>
      <ModelSelect key={disabled ? 'locked' : 'editable'} locked={disabled} available directory={directory} load={reload} t={t}
        renderSlot={renderSlot} resolveText={text => typeof text === 'string' ? text : text.zh ?? text.en ?? Object.values(text)[0] ?? ''}
        select={async selection => {
          if (disabled) return undefined
          const keepInheritedRoute = fallback && !hasRouteOverride && selection.provider === effectiveProvider
            && selection.model === effectiveModel
          onChange(keepInheritedRoute ? '' : selection.provider, keepInheritedRoute ? '' : selection.model, selection.reasoningEffort ?? null)
          return { ok: true, value: undefined }
        }} />
    </div>
    <span className={css.hint}>{providerText && <>提供方：{providerText} · </>}{inheritance}</span>
  </div>
}
