import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Verdict } from '../types.js'
import { DetailBody } from './ReviewDetail/index.js'
import { listReviewDetails } from './review-details-client.js'
import css from './ReviewDetail/styles.module.css'

export type ReviewSessionTarget = { id: string; ruleId: string; originSessionId?: string } | {
  ruleId: string
  startedAfter: number
  finishedBefore: number
  verdict: Verdict
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'medium', hourCycle: 'h23' })

export function ReviewSessionDialog({ target, parentSessionId, close, t }: PropsLocale<'conversation'> & {
  target: ReviewSessionTarget
  parentSessionId: string
  close: () => void
}) {
  const [resolved, setResolved] = useState<{ id: string } | { error: string }>()
  useEffect(() => {
    if ('id' in target) return
    const controller = new AbortController()
    const { signal } = controller
    void listReviewDetails(parentSessionId, signal).then(rows => {
      if (signal.aborted) return
      // 旧记录没有 ID，只在同规则、同裁决和此次尝试的时间范围内唯一匹配时打开。
      const matches = rows.filter(row => row.ruleId === target.ruleId && row.startedAt >= target.startedAfter
        && row.finishedAt <= target.finishedBefore && row.decision === target.verdict.decision
        && row.reason === target.verdict.reason)
      setResolved(matches.length === 1 ? { id: matches[0].id } : { error: '找不到唯一对应的历史审查会话。' })
    }, () => { if (!signal.aborted) setResolved({ error: '历史审查会话读取失败。' }) })
    return () => controller.abort()
  }, [parentSessionId, target])
  const detailId = 'id' in target ? target.id : resolved && 'id' in resolved ? resolved.id : undefined
  return <Modal open onClose={close} title={'审查子代理会话 · ' + target.ruleId} closeLabel='关闭'
    className={css.reviewModal} contentClassName={css.reviewModalContent}>
    {detailId ? <DetailBody parentSessionId={parentSessionId} rowId={detailId} dateFormat={dateFormat} t={t} />
      : resolved && 'error' in resolved ? <p role='alert' className={css.error}>{resolved.error}</p>
        : <p role='status' className={css.hint}>正在定位历史审查会话…</p>}
  </Modal>
}
