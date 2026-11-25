/** 使用共享的 DSH 展开行，保持设置草稿挂载。 */
import type { ReactNode } from 'react'
import { InlineDisclosure } from './InlineDisclosure.js'
import css from './SettingsEditor.module.css'

export function SettingsDisclosure({ title, children, defaultOpen = false }: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return <InlineDisclosure title={title} defaultOpen={defaultOpen}>
    <div className={css.disclosureBody}>{children}</div>
  </InlineDisclosure>
}
