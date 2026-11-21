/** 清晰区分被拒候选与对应注入，内容复用 DSH 原生渲染。 */
import type { CSSProperties } from 'react'
import { useId, useMemo } from 'react'
import { MarkdownText, MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/primitive-labels.ts'
import { CandidateTool } from './CandidateTool.js'
import { InjectionContent } from './InjectionContent.js'
import { InlineDisclosure } from './InlineDisclosure.js'
const card: CSSProperties = { margin: '16px 0', border: '1px solid var(--dsw-alias-border-l4, #8886)', borderLeft: '3px solid #b88828', borderRadius: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 'var(--dsh-content-font-size, 14px)' }
const section: CSSProperties = { padding: '14px 18px', borderTop: '1px solid var(--dsw-alias-border-l2, #8883)', minWidth: 0 }
const label: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600 }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 12 }
type Props = Omit<ChatNodeViewProps<'step-review'>, 't'> & PropsLocale<'conversation'>
export function ReviewNode({ node, cwd, openFile, useDisclosure, t }: Props) {
  const id = useId()
  const labels = useMemo(() => markdownLabels(t), [t])
  const { record, candidate, results, injection, stopped } = node.data
  const failed = record?.error || injection.startsWith('逐步骤审查发生故障')
  const title = failed ? '审查故障 · 本步已拦截' : '审查拒绝 · 本步已拦截'
  const rejected = results.filter(result => result.verdict.decision === 'reject')
  const location = node.location
  const turn = record?.turn ?? (location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined)
  const step = record?.step ?? (location.kind === 'step' ? location.step.step : undefined)
  return <MarkdownDelegateProvider openFile={openFile}>
    <article style={card} aria-labelledby={id} data-step-review-card>
      <header style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <strong id={id}>{title}</strong>
          <span style={muted}>{turn !== undefined ? '第 ' + turn + ' 轮' + (step !== undefined ? ' · 步骤 ' + step : '') + (record ? ' · 第 ' + record.correction + ' 次反馈' : '') : '历史审查记录'}</span>
        </div>
        <p style={{ ...muted, margin: '7px 0 0' }}>{stopped ? '自动订正已停止，等待处理。' : '订正反馈已注入原会话，要求重新生成本步。'}</p>
      </header>
      <section style={section} aria-label='本步被拒内容'>
        <h4 style={label}>本步生成的内容</h4>
        {candidate?.text ? <div data-step-review-original><MarkdownText text={candidate.text} labels={labels} /></div>
          : <p style={{ ...muted, margin: 0 }}>{candidate ? candidate.tools.length ? '本步仅生成工具调用。' : '本次候选没有可展示的正文或工具调用。' : node.data.candidateIncomplete ? '这条旧记录的候选数据已截断，请查看下方完整注入。' : '该记录未保存可展示的候选正文。'}</p>}
        {!!candidate?.tools.length && <div style={{ marginTop: 12 }}>
          <p style={{ ...muted, margin: '0 0 8px' }}>下列工具调用随本步一起拦截，均未执行。</p>
          {candidate.tools.map((tool, index) => <CandidateTool key={index} name={tool.name} arguments={tool.arguments}
            identity={String(node.key) + ':' + index} cwd={cwd} openFile={openFile} useDisclosure={useDisclosure} t={t} />)}
        </div>}
      </section>
      <section style={section} aria-label='对应的订正注入'>
        <h4 style={label}>对应的订正注入</h4>
        {rejected.map((result, index) => <div key={index} style={{ marginTop: index ? 12 : 0 }}>
          <span style={{ ...muted, fontFamily: 'monospace' }}>{result.ruleId}</span>
          <MarkdownText text={result.verdict.reason} labels={labels} />
          <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{result.verdict.suggestions.map((suggestion, i) => <li key={i}><MarkdownText text={suggestion} labels={labels} /></li>)}</ul>
        </div>)}
        {record?.error && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.error}</p>}
        <InlineDisclosure title='查看实际注入原会话的完整文本' defaultOpen={rejected.length === 0} style={{ marginTop: 12 }}>
          <InjectionContent injection={injection} identity={String(node.key)} cwd={cwd} openFile={openFile} useDisclosure={useDisclosure} t={t} />
        </InlineDisclosure>
      </section>
    </article>
  </MarkdownDelegateProvider>
}
