/** 待审可见字段仅交给展示组件，不产生工具执行事件。 */
import { useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/primitive-labels.ts'
import type { Candidate } from '../types.js'
import type { PreviewData } from './review-node.js'
import { CandidateTool } from './CandidateTool.js'
import { InlineDisclosure } from './InlineDisclosure.js'
import css from './PreviewContent.module.css'

type Props = Pick<ChatNodeViewProps<'step-review'>, 'cwd' | 'openFile' | 'useDisclosure'> & PropsLocale<'conversation'> & {
  preview: PreviewData
  candidate?: Candidate
  identity: string
  rejected?: boolean
}
export function PreviewContent({ preview, candidate, identity, rejected = false, cwd, openFile, useDisclosure, t }: Props) {
  const labels = useMemo(() => markdownLabels(t), [t])
  const streaming = !rejected && preview.phase === 'generating'
  const text = candidate?.text ?? preview.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n\n')
  const reasoning = preview.parts.filter(part => part.kind === 'reasoning').map(part => part.text).join('\n\n')
  const tools = candidate?.tools.map((tool, index) => ({ ...tool, key: 'candidate:' + index }))
    ?? preview.parts.filter(part => part.kind === 'tool-call').map(part => ({ name: part.name || '工具调用', arguments: part.text, key: 'part:' + part.index }))
  return <div className={css.content} data-step-review-preview>
    {preview.incomplete && !candidate && <p className={css.hint}>当前仅显示已加载片段，审核快照到达后补齐。</p>}
    {reasoning && <InlineDisclosure title='推理过程'>
      <div className={css.reasoning}><MarkdownText text={reasoning} streaming={streaming} labels={labels} variant='compact' /></div>
    </InlineDisclosure>}
    {text && <div data-step-review-original><MarkdownText text={text} streaming={streaming} labels={labels} /></div>}
    {!!tools.length && <div className={css.tools}>
      <p className={css.hint}>{rejected ? '下列工具调用已拦截，均未执行。' : '工具调用待审，尚未执行。'}</p>
      {tools.map(tool => <CandidateTool key={tool.key} name={tool.name} arguments={tool.arguments}
        pending={!rejected && (preview.phase === 'generating' || preview.phase === 'reviewing')} identity={identity + ':' + tool.key} cwd={cwd} openFile={openFile} useDisclosure={useDisclosure} t={t} />)}
    </div>}
    {!text && !reasoning && !tools.length && <p className={css.hint}>{streaming ? '等待生成内容…' : '本步没有可展示的内容。'}</p>}
  </div>
}
