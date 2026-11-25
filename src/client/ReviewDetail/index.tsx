import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/primitive-labels.ts'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewDetailSnapshot, ReviewDetailSelection, ReviewDetailSummary } from '../../review-detail-types.js'
import { deleteReviewDetails, getReviewDetail, listReviewDetails } from '../review-details-client.js'
import { ReviewTranscript } from './ReviewTranscript.js'
import css from './styles.module.css'

interface Props extends PropsLocale<'conversation'> {
  parentSessionId: string
  formatRule: (id: string) => string
  dateFormat: Intl.DateTimeFormat
}
type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; message: string }
type DeleteRequest = { row: ReviewDetailSummary } | { passed: true }

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function decisionText(row: ReviewDetailSummary): string {
  if (row.decision === 'pass') return '通过'
  if (row.decision === 'reject') return '拒绝'
  return row.error ? '审查出错' : '无裁决'
}

function ReviewTime({ value, format }: { value: number; format: Intl.DateTimeFormat }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <>未知</>
  return <time dateTime={date.toISOString()}>{format.format(date)}</time>
}

export function DetailBody({ parentSessionId, rowId, dateFormat, t }: Pick<Props, 'parentSessionId' | 'dateFormat' | 't'> & { rowId: string }) {
  const labels = useMemo(() => markdownLabels(t), [t])
  const [load, setLoad] = useState<Load<ReviewDetailSnapshot>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const detail = await getReviewDetail(parentSessionId, rowId, signal)
        if (signal.aborted) return
        setLoad({ kind: 'ready', value: detail })
        if (detail.finishedAt === null) timer = setTimeout(() => { void refresh() }, 1000)
      } catch (error) {
        if (!signal.aborted) setLoad({ kind: 'error', message: errorText(error, '审查详情读取失败。') })
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [parentSessionId, rowId, attempt])

  if (load.kind === 'loading') return <p className={css.hint} role='status'>正在读取审查详情…</p>
  if (load.kind === 'error') return <div className={css.controls}>
    <p className={css.error} role='alert'>{load.message}</p>
    <Button onClick={() => { setLoad({ kind: 'loading' }); setAttempt(value => value + 1) }}>重试读取</Button>
  </div>
  const detail = load.value
  return <>
    <dl className={css.facts}>
      <dt>状态</dt><dd>{detail.finishedAt === null ? '审查中' : decisionText(detail)}</dd>
      <dt>开始时间</dt><dd><ReviewTime value={detail.startedAt} format={dateFormat} /></dd>
      {detail.finishedAt !== null && <><dt>结束时间</dt><dd><ReviewTime value={detail.finishedAt} format={dateFormat} /></dd></>}
      {detail.reason && <><dt>原因</dt><dd>{detail.reason}</dd></>}
      {detail.error && <><dt>故障</dt><dd className={css.error}>{detail.error}</dd></>}
    </dl>
    <ReviewTranscript events={detail.events} labels={labels} />
  </>
}

export function ReviewDetails({ parentSessionId, formatRule, dateFormat, t }: Props) {
  const id = useId()
  const [rows, setRows] = useState<ReviewDetailSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string>()
  const [confirmation, setConfirmation] = useState<DeleteRequest>()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const deleteController = useRef<AbortController>()
  const toolbar = useRef<HTMLDivElement>(null)
  const confirmationBox = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    void listReviewDetails(parentSessionId, signal).then(records => {
      if (signal.aborted) return
      setRows([...records].sort((left, right) => right.finishedAt - left.finishedAt))
      setSelectedId(previous => records.some(record => record.id === previous) ? previous : undefined)
      setLoading(false)
    }, error => {
      if (signal.aborted) return
      setListError(errorText(error, '审查目录读取失败。'))
      setLoading(false)
    })
    return () => controller.abort()
  }, [parentSessionId, revision])
  useEffect(() => () => deleteController.current?.abort(), [])
  useEffect(() => {
    if (confirmation) confirmationBox.current?.focus()
  }, [confirmation])

  function reload() {
    setLoading(true)
    setListError(undefined)
    setRevision(value => value + 1)
  }

  function askToDelete(request: DeleteRequest) {
    setConfirmation(request)
    setDeleteError(undefined)
    setNotice(undefined)
  }

  async function confirmDelete(request: DeleteRequest) {
    if (deleteController.current) return
    const controller = new AbortController()
    deleteController.current = controller
    const signal = controller.signal
    const selection: ReviewDetailSelection = 'row' in request ? { ids: [request.row.id] } : { passed: true }
    const removed = (row: ReviewDetailSummary) => 'row' in request ? row.id === request.row.id : row.decision === 'pass'
    setDeleting(true)
    setDeleteError(undefined)
    try {
      const count = await deleteReviewDetails(parentSessionId, selection, signal)
      if (signal.aborted) return
      setRows(previous => previous.filter(row => !removed(row)))
      setSelectedId(previous => rows.some(row => row.id === previous && removed(row)) ? undefined : previous)
      setConfirmation(undefined)
      setNotice(count > 0 ? '已删除 ' + count + ' 条审查详情。' : '所选审查详情已不存在。')
      reload()
      toolbar.current?.focus()
    } catch (error) {
      if (!signal.aborted) setDeleteError(errorText(error, '审查详情删除失败，请重试。'))
    } finally {
      if (!signal.aborted) setDeleting(false)
      deleteController.current = undefined
    }
  }

  const passed = rows.some(row => row.decision === 'pass')
  const locked = loading || confirmation !== undefined
  return <div className={css.section}>
    <div className={css.controls} ref={toolbar} tabIndex={-1}>
      <Button disabled={locked} onClick={reload}>刷新详情</Button>
      <Button disabled={locked || !!listError || !passed} onClick={() => askToDelete({ passed: true })}>删除已通过详情</Button>
    </div>
    {confirmation && <div className={css.confirmation} ref={confirmationBox} tabIndex={-1} aria-labelledby={id + '-confirm'} role='group'>
      <p id={id + '-confirm'}>{'row' in confirmation ? '删除「' + formatRule(confirmation.row.ruleId) + '」的这条审查详情？' : '删除当前会话所有裁决为通过的审查详情？'} 此操作无法撤销。</p>
      <div className={css.controls}>
        <Button disabled={deleting} onClick={() => { void confirmDelete(confirmation) }}>{deleting ? '正在删除…' : '确认删除'}</Button>
        <Button disabled={deleting} onClick={() => { setConfirmation(undefined); setDeleteError(undefined); toolbar.current?.focus() }}>取消</Button>
      </div>
      {deleteError && <p className={css.error} role='alert'>{deleteError}</p>}
    </div>}
    {notice && <p className={css.hint} role='status'>{notice}</p>}
    {loading && <p className={css.hint} role='status'>正在读取审查详情列表…</p>}
    {listError && <p className={css.error} role='alert'>{listError}</p>}
    {!loading && !listError && !rows.length && <p className={css.hint}>当前会话暂无附属审查详情。</p>}
    {rows.length > 0 && <ul className={css.list} role='list'>
      {rows.map(row => {
        const open = selectedId === row.id
        const rule = formatRule(row.ruleId)
        const panelId = id + '-' + row.id
        return <li key={row.id} className={css.item}>
          <div className={css.row}>
            <div className={css.summary}>
              <strong>{rule}</strong>
              <span data-decision={row.decision ?? 'unknown'}>
                <Tag tone={row.decision === 'pass' ? 'success' : row.decision === 'reject' || row.error ? 'danger' : 'quiet'}>{decisionText(row)}</Tag>
              </span>
              <span className={css.hint}><ReviewTime value={row.finishedAt} format={dateFormat} /></span>
            </div>
            <div className={css.controls}>
              <Button aria-expanded={open} aria-controls={panelId} aria-label={(open ? '收起' : '查看') + rule + '审查详情'}
                onClick={() => setSelectedId(open ? undefined : row.id)}>{open ? '收起详情' : '查看详情'}</Button>
              <Button disabled={locked} aria-label={'删除' + rule + '审查详情'} onClick={() => askToDelete({ row })}>删除</Button>
            </div>
          </div>
          <div id={panelId} hidden={!open} className={css.detail}>
            {open && <DetailBody parentSessionId={parentSessionId} rowId={row.id} dateFormat={dateFormat} t={t} />}
          </div>
        </li>
      })}
    </ul>}
  </div>
}
