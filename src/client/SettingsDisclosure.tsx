/** 设置页的分组展开入口，保持内容挂载与键盘可访问性。 */
import { useId, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsEditor.module.css'
export function SettingsDisclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  return <div className={css.disclosure}>
    <Button className={css.disclosureButton} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{title}</span><IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : css.chevron} />
    </Button>
    <div hidden={!open} id={id} role='region' aria-label={title}><div className={css.disclosureBody}>{children}</div></div>
  </div>
}
