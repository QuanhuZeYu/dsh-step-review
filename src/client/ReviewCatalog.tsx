/** 历史审查由公开会话事件源归并，附属详情由插件独立读取。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionEventChange, SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useId, useMemo, useRef } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ReviewDetails } from './ReviewDetail/index.js'
import css from './ReviewCatalog.module.css'

const activityRecordType = 'plugin:step-review/activity'
interface ReviewActivity {
  version: 1
  reviewerSessionId: string
  parentSessionId: string
  ruleId: string
  phase: 'started' | 'completed' | 'failed'
  time: number
  error?: string
}
export interface ReviewCatalogRow {
  reviewerSessionId: string
  ruleId: string
  phase: ReviewActivity['phase'] | 'legacy'
  time: number
  startedAt?: number
  error?: string
}
function objectOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function activityOf(value: unknown): ReviewActivity | undefined {
  if (!objectOf(value) || value.version !== 1 || typeof value.reviewerSessionId !== 'string' || !value.reviewerSessionId
    || typeof value.parentSessionId !== 'string' || !value.parentSessionId || typeof value.ruleId !== 'string'
    || (value.phase !== 'started' && value.phase !== 'completed' && value.phase !== 'failed')
    || typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0
    || (value.error !== undefined && typeof value.error !== 'string')) return undefined
  return value as unknown as ReviewActivity
}
interface IndexedReviewCatalogRow extends ReviewCatalogRow { seq: number }
interface ReviewCatalogCache {
  parentSessionId: string
  revision: number
  rows: Map<string, IndexedReviewCatalogRow>
}
function consumeEntry(entry: SessionEventLikeEntry, rows: Map<string, IndexedReviewCatalogRow>, parentSessionId: string): void {
  if (entry.type !== 'event') return
  const event = entry.event
  const rawEvent: unknown = event
  if (objectOf(rawEvent) && rawEvent.type === activityRecordType && rawEvent.ignorable === true) {
    const activity = activityOf(rawEvent.data)
    if (!activity || activity.parentSessionId !== parentSessionId) return
    const previous = rows.get(activity.reviewerSessionId)
    if (previous && previous.phase !== 'legacy' && event.seq < previous.seq) {
      // 较早页补充开始时间，但不能让旧状态覆盖已记录的终态。
      if (activity.phase === 'started' && previous.startedAt === undefined) {
        rows.set(activity.reviewerSessionId, { ...previous, startedAt: activity.time })
      }
      return
    }
    rows.set(activity.reviewerSessionId, { reviewerSessionId: activity.reviewerSessionId, ruleId: activity.ruleId,
      phase: activity.phase, time: activity.time, seq: event.seq, error: activity.error,
      startedAt: activity.phase === 'started' ? activity.time : previous?.startedAt })
    return
  }
  if (event.type !== 'user/message') return
  const source: unknown = event.data.source
  const review = objectOf(source) && source.kind === 'step-review' && objectOf(source.review) ? source.review : undefined
  if (!review || !Array.isArray(review.results)) return
  for (const result of review.results) {
    if (!objectOf(result) || typeof result.reviewerSessionId !== 'string' || !result.reviewerSessionId
      || result.reviewerSessionId.startsWith('step-review-detail-') || typeof result.ruleId !== 'string') continue
    const previous = rows.get(result.reviewerSessionId)
    if (previous && (previous.phase !== 'legacy' || previous.seq >= event.seq)) continue
    rows.set(result.reviewerSessionId, { reviewerSessionId: result.reviewerSessionId, ruleId: result.ruleId,
      phase: 'legacy', time: event.time, seq: event.seq })
  }
}
function rebuildCatalog(window: SessionEventWindow, parentSessionId: string): ReviewCatalogCache {
  const rows = new Map<string, IndexedReviewCatalogRow>()
  for (const entry of window.entries) consumeEntry(entry, rows, parentSessionId)
  return { parentSessionId, revision: window.revision, rows }
}
/** 折叠窗口精确change；漏过revision时回退快照，活动增量只处理新增页。 */
function updateCatalog(window: SessionEventWindow, parentSessionId: string, cache: { current: ReviewCatalogCache | undefined }): ReviewCatalogRow[] {
  let current = cache.current
  if (!current || current.parentSessionId !== parentSessionId || window.change.kind === 'replace') {
    current = rebuildCatalog(window, parentSessionId)
  } else if (window.revision !== current.revision) {
    if (window.revision !== current.revision + 1) {
      current = rebuildCatalog(window, parentSessionId)
    } else {
      const rows = new Map(current.rows)
      const change: SessionEventChange = window.change
      if (change.kind === 'append' || change.kind === 'prepend') {
        for (const entry of change.entries) consumeEntry(entry, rows, parentSessionId)
      }
      // settle-assistant 仅替换瞬态Assistant行并可插入Assistant结束记录；两者不属于审查目录。
      current = { parentSessionId, revision: window.revision, rows }
    }
  }
  cache.current = current
  return [...current.rows.values()].sort((left, right) => right.time - left.time)
}
interface ReviewCatalogInjected {
  hooks: { events: SessionBinding['eventSource'] }
  loadOlder: () => Promise<void>
  openReview: (sessionId: string) => void
}
type Props = PropsRuntime<'conversation.view'> & InjectFace<ReviewCatalogInjected> & PropsLocale<'conversation'>

const ruleNames = new Map([
  ['commit-message', '提交说明'],
  ['release-body', '发布正文'],
  ['unnecessary-backup', '多余备份'],
  ['clear-writing', '表述清晰度'],
  ['evidence-alignment', '结论与证据'],
  ['synthesized-delivery', '交付内容整合'],
])
const phaseLabels = {
  started: { status: '已开始', time: '开始时间' },
  completed: { status: '已完成', time: '完成时间' },
  failed: { status: '审查出错', time: '出错时间' },
  legacy: { status: '历史记录', time: '记录时间' },
} satisfies Record<ReviewCatalogRow['phase'], { status: string; time: string }>
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'long', timeStyle: 'medium', hourCycle: 'h23',
})

function ReviewCatalogEntry({ row, openReview }: { row: ReviewCatalogRow; openReview: ReviewCatalogInjected['openReview'] }) {
  const id = useId()
  const phase = phaseLabels[row.phase]
  const date = new Date(row.time)
  const hasTime = Number.isFinite(date.getTime())
  const duration = (row.phase === 'completed' || row.phase === 'failed')
    && row.startedAt !== undefined && row.time >= row.startedAt
    ? ((row.time - row.startedAt) / 1000).toFixed(2) : undefined

  return <li data-phase={row.phase}>
    <button type='button' className={css.row} onClick={() => openReview(row.reviewerSessionId)}
      aria-labelledby={id + '-action ' + id + '-rule'} aria-describedby={id + '-status ' + id + '-details'}>
      <span className={css.heading}>
        <strong id={id + '-rule'} className={css.rule}>{ruleNames.get(row.ruleId) ?? (row.ruleId || '未命名规则')}</strong>
        <span id={id + '-status'}>
          <Tag tone={row.phase === 'started' ? 'info' : row.phase === 'failed' ? 'danger' : 'quiet'}>{phase.status}</Tag>
        </span>
      </span>
      <span id={id + '-details'} className={css.details}>
        <span className={css.meta}>{phase.time} {hasTime
          ? <time dateTime={date.toISOString()}>{dateFormat.format(date)}</time>
          : '未知'}</span>
        {duration !== undefined && <span className={css.meta}>耗时 {duration} 秒</span>}
        {row.error && <span className={css.error}>{row.error}</span>}
      </span>
      <span id={id + '-action'} className={css.action}>打开审查会话<span aria-hidden='true'>›</span></span>
    </button>
  </li>
}
function ReviewCatalog({ useSession, useEvents, loadOlder, openReview, t }: Props) {
  const id = useId()
  const sessionId = useSession(session => session.sessionId)
  const historyStatus = useSession(session => session.historyLoadStatus)
  const window = useEvents(value => value)
  const cache = useRef<ReviewCatalogCache>()
  const rows = useMemo(() => updateCatalog(window, sessionId, cache), [window, sessionId])
  const loading = historyStatus === 'loading'
  return <section className={css.catalog} aria-labelledby={id}>
    <h2 id={id} className={css.title}>审查目录</h2>
    <ReviewDetails key={sessionId} parentSessionId={sessionId}
      formatRule={ruleId => ruleNames.get(ruleId) ?? (ruleId || '未命名规则')} dateFormat={dateFormat} t={t} />
    {rows.length > 0 && <h3 className={css.subtitle}>历史审查会话</h3>}
    {rows.length > 0 && <ul className={css.list} role='list'>
      {rows.map(row => <ReviewCatalogEntry key={row.reviewerSessionId} row={row} openReview={openReview} />)}
    </ul>}
    {window.hasMore && <Button disabled={loading} onClick={() => { void loadOlder() }}>{loading ? '正在读取…' : '加载更早记录'}</Button>}
    {historyStatus === 'error' && <p className={css.error} role='alert'>较早的会话记录读取失败，请重试。</p>}
  </section>
}
export function registerReviewCatalog(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-step-review/catalog',
    order: 50,
    label: '审查目录',
    locale: 'conversation',
    inject: (sessionId: SessionId): ReviewCatalogInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (!binding) throw new Error('找不到审查目录所属会话：' + sessionId)
      return { hooks: { events: binding.eventSource }, loadOlder: () => binding.session.loadOlder(),
        openReview: target => ctx.uiWorkspace.openSession(target as SessionId) }
    },
  }, ReviewCatalog))
}
