/** 完整注入的阅读与原文共用一个展开区，原始副本始终原样保留。 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Button, CodeBlock, MarkdownText, SegmentedControl, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/primitive-labels.ts'
import { CandidateTool } from './CandidateTool.js'
import { cardData, marker } from './review-node.js'
import css from './InjectionContent.module.css'
type View = 'reading' | 'source'
const views = [{ value: 'reading' as const, label: '阅读' }, { value: 'source' as const, label: '原文' }]
type Props = Pick<ChatNodeViewProps<'step-review'>, 'cwd' | 'openFile' | 'useDisclosure'> & PropsLocale<'conversation'> & {
  injection: string
  identity: string
}
export function InjectionContent({ injection, identity, cwd, openFile, useDisclosure, t }: Props) {
  const id = useId()
  const [view, setView] = useState<View>('reading')
  const [wrap, setWrap] = useState(true)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const labels = useMemo(() => markdownLabels(t), [t])
  // 阅读视图只解析实际注入副本，不用更完整的候选元数据补齐截断材料。
  const injected = useMemo(() => cardData(undefined, injection), [injection])
  const markerAt = injection.indexOf(marker)
  const instructions = markerAt < 0 ? injection : injection.slice(0, markerAt)
  const tail = markerAt < 0 ? '' : injection.slice(markerAt + marker.length)
  useEffect(() => { setCopy('idle') }, [injection])
  return <div className={css.panel} data-step-review-injection>
    <div className={css.toolbar}>
      <SegmentedControl id={id} value={view} options={views} onChange={setView} label='注入内容展示方式' />
      <div className={css.actions}>
        {view === 'source' && <Button size='sm' variant='ghost' aria-pressed={wrap} onClick={() => setWrap(!wrap)}>自动换行</Button>}
        <Button size='sm' variant='ghost' aria-live='polite' onClick={async () => setCopy(await writeClipboard(injection) ? 'copied' : 'failed')}>
          {copy === 'copied' ? '已复制原文' : '复制原文'}
        </Button>
      </div>
    </div>
    {copy === 'failed' && <p className={css.copyStatus} role='status'>复制失败，请在原文视图中选择文本复制。</p>}
    <div id={id + '-reading-panel'} role='tabpanel' tabIndex={0} aria-labelledby={id + '-reading'} hidden={view !== 'reading'} className={css.reading}>
      <div className={css.instructions}><MarkdownText text={instructions} labels={labels} /></div>
      {markerAt >= 0 && <div className={css.candidate}>
        <h4 className={css.heading}>注入中的被拒候选</h4>
        {injected.candidate ? <>
          {injected.candidate.text && <MarkdownText text={injected.candidate.text} labels={labels} />}
          {!!injected.candidate.tools.length && <p className={css.hint}>工具调用均未执行。</p>}
          {injected.candidate.tools.map((tool, index) => <CandidateTool key={index} name={tool.name} arguments={tool.arguments}
            identity={identity + ':injected:' + index} cwd={cwd} openFile={openFile} useDisclosure={useDisclosure} t={t} />)}
        </> : <>
          <p className={css.hint}>候选数据未完整保存，以下为实际注入的片段。</p>
          <CodeBlock code={tail} lang='json' wrap {...labels.code} />
        </>}
      </div>}
    </div>
    <div id={id + '-source-panel'} role='tabpanel' tabIndex={0} aria-labelledby={id + '-source'} hidden={view !== 'source'} className={css.source}>
      <CodeBlock code={injection} lang='text' showHeader={false} wrap={wrap} {...labels.code} />
    </div>
  </div>
}
