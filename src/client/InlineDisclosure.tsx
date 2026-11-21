/** 统一使用 DSH 展开行，收起时保留内容与编辑状态。 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { DisclosureRow, IconInspectOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
export function InlineDisclosure({ title, defaultOpen = false, style, children }: {
  title: string; defaultOpen?: boolean; style?: CSSProperties; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return <div style={style}>
    <DisclosureRow icon={<IconInspectOutlineRegular size={14} />} title={title} open={open}
      expandable expandOnRowClick onToggle={() => setOpen(value => !value)} />
    <div hidden={!open} role='region' aria-label={title}>{children}</div>
  </div>
}
