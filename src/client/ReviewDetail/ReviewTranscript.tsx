import { CodeBlock, MarkdownText, UserMessageBubble, UserTextRun, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { InlineDisclosure } from '../InlineDisclosure.js'
import css from './styles.module.css'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

type Entry = { kind: 'input' | 'reply'; text: string } | { kind: 'tool'; label: string; text: string; json?: boolean }

function toEntry(event: unknown): Entry | undefined {
  if (!record(event) || !record(event.data)) return undefined
  const data = event.data
  switch (event.type) {
    case 'user/message': {
      const text = textContent(data.content)
      return text ? { kind: 'input', text } : undefined
    }
    case 'assistant/message': {
      const text = record(data.message) ? textContent(data.message.content) : ''
      return text ? { kind: 'reply', text } : undefined
    }
    case 'tool/call':
      return typeof data.name === 'string' ? {
        kind: 'tool', label: '调用 ' + data.name,
        text: typeof data.arguments === 'string' ? data.arguments : '', json: true,
      } : undefined
    case 'tool/result':
      return record(data.message) ? {
        kind: 'tool', label: data.message.isError === true ? '工具出错' : '工具结果',
        text: textContent(data.message.content),
      } : undefined
  }
}

export function ReviewTranscript({ events, labels }: { events: readonly unknown[]; labels: MarkdownLabels }) {
  const entries = events.flatMap(event => {
    const entry = toEntry(event)
    return entry ? [entry] : []
  })
  return entries.length ? <ol className={css.transcript} role='list' aria-label='审查过程'>
    {entries.map((entry, index) => <li key={index}>
      {entry.kind === 'input' ? <UserMessageBubble className={css.input} aria-label='审查输入'>
        <UserTextRun text={entry.text} />
      </UserMessageBubble> : entry.kind === 'reply' ? <div aria-label='审查回复'>
        <MarkdownText text={entry.text} labels={labels} />
      </div> : entry.kind === 'tool' && <InlineDisclosure title={entry.label} defaultOpen>
        {entry.text ? <CodeBlock code={entry.text} lang={entry.json ? 'json' : undefined} {...labels.code} /> : '无文本内容'}
      </InlineDisclosure>}
    </li>)}
  </ol> : <p className={css.hint}>此详情没有可展示的消息或工具记录。</p>
}
