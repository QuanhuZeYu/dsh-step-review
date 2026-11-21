/** 配置草稿的选项控件，复用 DSH 设置页的原生菜单与按钮。 */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsSelect.module.css'
export function SettingsSelect<Value extends string>({ label, value, options, onChange, disabled = false }: {
  label: string
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
  disabled?: boolean
}) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.value === value)?.label ?? value
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <div className={css.field}>
    <span id={id + '-label'}>{label}</span>
    <Menu open={open && !disabled} onClose={() => setOpen(false)} portal autoFocus minWidthFromAnchor
      anchorRef={anchor} selectedId={value} items={options.map(option => ({ id: option.value, label: option.label }))}
      onSelect={key => {
        if (disabled) return
        const option = options.find(item => item.value === key)
        if (option) { onChange(option.value); setOpen(false) }
      }}
      anchor={<Button ref={anchor} className={css.trigger} variant='outline' disabled={disabled}
        aria-labelledby={id + '-label ' + id + '-value'} aria-haspopup='menu' aria-expanded={open && !disabled}
        onClick={() => setOpen(value => !value)}>
        <span id={id + '-value'} className={css.value} title={current}>{current}</span>
        <IconChevronDownOutlineRegular size={14} />
      </Button>} />
  </div>
}
