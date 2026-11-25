import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { abortable, cleanup } from './review-async.js'
import { ReviewError, safeErrorMessage } from './failure.js'
import { reviewDetailPath, type ReviewDetail, type ReviewDetailSnapshot, type ReviewDetailSummary } from './review-detail-types.js'

const id = z.string().min(1).max(256)
const reviewSpec = defineDomain({
  name: 'step_review_details', version: 1, layout: 'per-record',
  tables: { details: domainTable(z.object({
    id, parentSessionId: id, ruleId: z.string(), startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative(), decision: z.enum(['pass', 'reject']).optional(),
    reason: z.string().optional(), error: z.string().optional(), events: z.array(z.json()),
  })) },
})
const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), parentSessionId: id }),
  z.strictObject({ action: z.literal('get'), parentSessionId: id, id }),
  z.strictObject({ action: z.literal('delete'), parentSessionId: id, selection: z.union([
    z.strictObject({ ids: z.array(id).min(1).max(500) }), z.strictObject({ passed: z.literal(true) }),
  ]) }),
])

function key(parentSessionId: string, detailId: string): string {
  return createHash('sha256').update(JSON.stringify([parentSessionId, detailId])).digest('hex')
}

function summary({ id, parentSessionId, ruleId, startedAt, finishedAt, decision, reason, error }: ReviewDetail): ReviewDetailSummary {
  return { id, parentSessionId, ruleId, startedAt, finishedAt, decision, reason, error }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

interface DetailDomain {
  opening?: Promise<Domain<typeof reviewSpec>>
  resetting?: Promise<void>
  mounts: Set<Context>
  active: Map<string, () => ReviewDetailSnapshot>
  pending: Map<string, ReviewDetail>
  removed: WeakSet<ReviewDetail>
  detachConnection?: () => Promise<void>
}
const domains = new WeakMap<Context['storageDomain'], DetailDomain>()

function openDetails(ctx: Context, entry: DetailDomain): Promise<Domain<typeof reviewSpec>> {
  if (domains.get(ctx.storageDomain) !== entry || entry.mounts.size === 0) return Promise.reject(new ReviewError('审查详情存储所属插件已卸载', { code: 'STEP_REVIEW_DETAILS_CLOSED', stage: '详情存储' }))
  if (entry.resetting) return entry.resetting.then(() => openDetails(ctx, entry))
  if (!entry.opening) {
    const opening = ctx.storageDomain.open(reviewSpec)
    entry.opening = opening
    void opening.catch(error => {
      if (entry.opening === opening) entry.opening = undefined
      ctx.root.logger.warn('打开审查详情存储失败，后续访问将重试：' + safeErrorMessage(error))
    })
  }
  return entry.opening!
}

/** 存储域隔离或已关闭时，先完成旧 handle 关闭再重新打开，避免同名双开。 */
function resetDetails(ctx: Context, entry: DetailDomain, error: unknown): Promise<void> | undefined {
  let code: unknown
  try { code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined } catch { return }
  if (code !== 'unknown-state' && code !== 'closed') return
  if (entry.resetting) return entry.resetting
  const opening = entry.opening
  if (!opening) return
  entry.resetting = opening.then(domain => domain.close()).catch(cause => {
    ctx.root.logger.warn('审查详情存储关闭失败：' + safeErrorMessage(cause))
  }).finally(() => {
    if (entry.opening === opening) entry.opening = undefined
    entry.resetting = undefined
  })
  return entry.resetting
}

export async function mountReviewDetails(ctx: Context): Promise<void> {
  const owner = ctx.storageDomain
  let entry = domains.get(owner)
  if (!entry) {
    entry = { mounts: new Set(), active: new Map(), pending: new Map(), removed: new WeakSet() }
    domains.set(owner, entry)
  }
  const current = entry
  current.mounts.add(ctx)
  void openDetails(ctx, current).catch(() => {})
  ctx.effect(() => async () => {
    current.mounts.delete(ctx)
    if (current.mounts.size > 0) return
    if (domains.get(owner) === current) domains.delete(owner)
    current.active.clear()
    current.pending.clear()
    cleanup(async () => {
      try { await current.detachConnection?.() }
      finally { await (await current.opening?.catch(() => undefined))?.close() }
    }, error => ctx.root.logger.warn('关闭审查详情存储失败：' + safeErrorMessage(error)))
  }, 'step-review: 审查详情存储')
  if (current.detachConnection) return
  const registration = ctx.root.inject(['connection'], scope => {
    scope.connection.fetch.register({
      path: '/' + reviewDetailPath, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') return json(null, 415)
        let body: unknown
        try { body = await request.json() } catch { return json(null, 400) }
        const parsed = requestSchema.safeParse(body)
        if (!parsed.success) return json(null, 400)
        const input = parsed.data
        try {
          if (input.action === 'get') {
            const recordKey = key(input.parentSessionId, input.id)
            const cached = current.pending.get(recordKey)
            if (cached) return json(cached)
            const active = current.active.get(recordKey)
            if (active) return json(active())
          }
          const table = (await abortable(openDetails(ctx, current), AbortSignal.timeout(1000))).table('details')
          if (input.action === 'get') {
            const detail = table.get(key(input.parentSessionId, input.id))
            return detail?.parentSessionId === input.parentSessionId ? json(detail) : json(null, 404)
          }
          if (input.action === 'delete' && 'ids' in input.selection) {
            const keys = input.selection.ids.map(detailId => key(input.parentSessionId, detailId))
            for (const recordKey of keys) {
              const pending = current.pending.get(recordKey)
              if (pending) current.removed.add(pending)
              current.pending.delete(recordKey)
            }
            return json(await table.deleteMany(keys))
          }
          const all = new Map<string, ReviewDetail>(table.entries())
          for (const [recordKey, detail] of current.pending) all.set(recordKey, detail)
          const records = [...all].filter(([, detail]) => detail.parentSessionId === input.parentSessionId)
          if (input.action === 'list') return json(records.map(([, detail]) => summary(detail)))
          const passed = records.filter(([, detail]) => detail.decision === 'pass')
          for (const [recordKey, detail] of passed) { current.removed.add(detail); current.pending.delete(recordKey) }
          return json(await table.deleteMany(passed.map(([recordKey]) => recordKey)))
        } catch (error) {
          void resetDetails(ctx, current, error)
          ctx.root.logger.warn('审查详情操作失败：' + safeErrorMessage(error))
          if (input.action === 'list') return json([...current.pending.values()].filter(detail => detail.parentSessionId === input.parentSessionId).map(summary))
          return json(null, 503)
        }
      },
    })
  })
  current.detachConnection = () => registration.dispose()
}

/** 只保存审查对话与只读工具的可见内容，省略模型请求、系统提示、流与附件。 */
export function projectReviewEvents(events: readonly SessionEvent[]): ReviewDetail['events'] {
  function text(content: readonly { type: string }[]) {
    return content.flatMap(block => block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [{ type: 'text', text: block.text }] : [])
  }
  const projected = []
  for (const event of events) {
    const { type, seq, time } = event
    switch (type) {
      case 'user/message':
        projected.push({ type, seq, time, data: { content: text(event.data.content) } })
        break
      case 'assistant/message':
        projected.push({ type, seq, time, data: { message: { content: text(event.data.message.content) } } })
        break
      case 'tool/call':
        projected.push({ type, seq, time, data: { name: event.data.name, arguments: event.data.arguments, callId: event.data.callId } })
        break
      case 'tool/result': {
        const { content, toolCallId, isError } = event.data.message
        projected.push({ type, seq, time, data: { message: { content: text(content), toolCallId, isError: isError ?? false } } })
        break
      }
    }
  }
  return projected
}

/** 详情打开后可读取正在运行的审查，完成时切换到持久化记录。 */
export function registerActiveReview(ctx: Context, metadata: Omit<ReviewDetailSummary, 'finishedAt'>, events: () => readonly SessionEvent[]): () => void {
  const active = domains.get(ctx.storageDomain)?.active
  const recordKey = key(metadata.parentSessionId, metadata.id)
  active?.set(recordKey, () => ({ ...metadata, finishedAt: null, events: projectReviewEvents(events()) }))
  return () => { active?.delete(recordKey) }
}

export async function saveReviewDetail(ctx: Context, detail: ReviewDetail): Promise<void> {
  const entry = domains.get(ctx.storageDomain)
  if (!entry) throw new Error('审查详情存储尚未加载')
  const recordKey = key(detail.parentSessionId, detail.id)
  entry.pending.set(recordKey, detail)
  // 磁盘慢时保留最近完成记录供查看，缓存上限不影响后台持久化。
  if (entry.pending.size > 128) entry.pending.delete(entry.pending.keys().next().value!)
  const { events, ...metadata } = detail
  const record = { ...metadata, events: z.array(z.json()).parse(events) }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const table = (await openDetails(ctx, entry)).table('details')
      if (entry.removed.has(detail)) return
      await table.put(recordKey, record)
      if (entry.pending.get(recordKey) === detail) entry.pending.delete(recordKey)
      return
    } catch (error) {
      const resetting = resetDetails(ctx, entry, error)
      if (attempt === 0 && resetting) { await resetting; continue }
      throw error
    }
  }
}