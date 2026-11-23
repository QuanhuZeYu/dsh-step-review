/** 审查模型及手动路由，统一使用设置表单的字段布局。 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentProps } from 'react'
import { ReviewModelSelect } from './ReviewModelSelect.js'
import { SettingsDisclosure } from './SettingsDisclosure.js'
import css from './SettingsEditor.module.css'
export function RouteEditor(props: Omit<ComponentProps<typeof ReviewModelSelect>, 'label'>) {
  const { provider, model, onChange, disabled, fallback } = props
  return <div className={css.stack}>
    <ReviewModelSelect {...props} label={fallback ? '本规则审查模型' : '默认审查模型'} />
    <SettingsDisclosure title='手动填写模型标识'>
      <p className={css.hint}>用于目录中未列出的模型。修改标识后，推理等级恢复为默认设置。</p>
      <div className={css.columns}>
        <label className={css.field}><span>Provider</span><Input className={css.input} value={provider} disabled={disabled}
          placeholder={fallback ? '继承默认 Provider' : 'Provider 标识'} onChange={event => onChange(event.target.value, model, '')} /></label>
        <label className={css.field}><span>Model</span><Input className={css.input} value={model} disabled={disabled}
          placeholder={fallback ? '继承默认 Model' : 'Model 标识'} onChange={event => onChange(provider, event.target.value, '')} /></label>
      </div>
    </SettingsDisclosure>
  </div>
}
