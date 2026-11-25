import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { classifyReviewIdentity } from '../review-identity.js'
import { isReviewSessionId } from '../review-session-id.js'

type WorkspaceSnapshot = ReturnType<Context['workspaces']['list']['getSnapshot']>
const sidebar = '[data-sidebar-list-area]'

function sessionRow(id: string): string {
  return '[role="treeitem"][data-row-key="' + CSS.escape('session:' + id) + '"]'
}

/** 只在普通会话都已渲染时隐藏折叠按钮，保留进一步访问普通会话的入口。 */
function overflowSelectors(
  list: SessionListState,
  workspace: WorkspaceSnapshot,
  reviewerIds: ReadonlySet<string>,
): string[] {
  if (list.phase !== 'ready' || workspace.phase !== 'ready' || workspace.state !== 'idle' || reviewerIds.size === 0) return []
  const accounted = new Set(workspace.items.flatMap(item => item.sessionIds))
  const groups = workspace.items.map(item => ({ key: item.workspaceId as string, ids: item.sessionIds }))
  groups.push({ key: '', ids: list.ids.filter(id => !accounted.has(id) && list.byId[id]?.origin !== 'subagent') })
  const selectors: string[] = []
  for (const { key, ids } of groups) {
    if (!ids.some(id => reviewerIds.has(id))) continue
    if (key === '' && ids.every(id => reviewerIds.has(id))) {
      selectors.push(sidebar + ' div:has(> [role="treeitem"][data-row-key="workspace:"])')
      continue
    }
    const ordinary = [...new Set(ids.filter(id => !reviewerIds.has(id) && list.byId[id]?.blank !== true))].sort()
    // 仅核对少量普通会话，较大的分组沿用宿主的展开操作。
    if (ordinary.length > 5 || ordinary.some(id => id.includes('\0'))) continue
    const hasOrdinaryRows = ordinary.map(id => ':has(> ' + sessionRow(id) + ')').join('')
    selectors.push(sidebar + ' *' + hasOrdinaryRows + ' > button[aria-expanded="false"][data-row-key="'
      + CSS.escape('overflow:' + key) + '"]')
  }
  return selectors
}

const legacyId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const concurrency = 3
const retryDelayMs = 15_000

/** 订阅原生快照，样式跟随插件生命周期。 */
export function registerCatalogSidebar(ctx: Context): void {
  const list = ctx.sessions.list
  const workspaces = ctx.get('workspaces') as Context['workspaces'] | undefined
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.stepReviewSidebar = ''
    document.head.append(style)

    const controller = new AbortController()
    const checked = new Map<string, boolean>()
    const withoutFirstMessage = new Map<string, number>()
    const retryAfter = new Map<string, number>()
    const pending = new Set<string>()
    let currentStyle = ''
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    function sync() {
      const snapshot = list.getSnapshot()
      const reviewerIds = new Set<string>()
      for (const id of snapshot.ids) {
        if (isReviewSessionId(id) || checked.get(id) === true) reviewerIds.add(id)
      }
      const selectors = [...reviewerIds].sort().map(id => sidebar + ' ' + sessionRow(id))
      const overflow = workspaces ? overflowSelectors(snapshot, workspaces.list.getSnapshot(), reviewerIds) : []
      const rules = [selectors, overflow].filter(group => group.length > 0)
      const nextStyle = rules.map(group => group.join(',\n') + ' { display: none !important; }').join('\n')
      if (nextStyle !== currentStyle) {
        currentStyle = nextStyle
        style.textContent = nextStyle
      }
      if (snapshot.phase !== 'ready') return

      const now = Date.now()
      let nextRetry = Infinity
      for (const sessionId of snapshot.ids) {
        if (pending.size >= concurrency) break
        if (!legacyId.test(sessionId) || checked.has(sessionId) || pending.has(sessionId)) continue
        const row = snapshot.byId[sessionId]
        if (!row || row.blank || row.parentId || row.origin || withoutFirstMessage.get(sessionId) === row.updatedAt) continue
        const retryAt = retryAfter.get(sessionId)
        if (retryAt !== undefined && retryAt > now) {
          nextRetry = Math.min(nextRetry, retryAt)
          continue
        }
        pending.add(sessionId)
        const updatedAt = row.updatedAt
        void ctx.remote.session.events({
          address: { kind: 'session', sessionId }, beforeSeq: 16, maxMessages: 16,
        }, controller.signal).then(result => {
          if (controller.signal.aborted) return
          if (!result.ok) {
            if (result.error.code === 'session/not-found' || /stored log is corrupt|stored session .+ is corrupt/.test(result.error.message)) {
              withoutFirstMessage.set(sessionId, updatedAt)
              return
            }
            throw result.error
          }
          retryAfter.delete(sessionId)
          const identity = classifyReviewIdentity(result.value)
          if (identity === undefined) withoutFirstMessage.set(sessionId, updatedAt)
          else checked.set(sessionId, identity)
        }).catch(() => {
          if (!controller.signal.aborted) retryAfter.set(sessionId, Date.now() + retryDelayMs)
        }).finally(() => {
          pending.delete(sessionId)
          if (!controller.signal.aborted) sync()
        })
      }
      clearTimeout(retryTimer)
      retryTimer = Number.isFinite(nextRetry) ? setTimeout(sync, nextRetry - now) : undefined
    }

    const unsubscribe = list.subscribe(sync)
    const unsubscribeWorkspaces = workspaces?.list.subscribe(sync)
    sync()
    return () => {
      controller.abort()
      clearTimeout(retryTimer)
      unsubscribeWorkspaces?.()
      unsubscribe()
      style.remove()
    }
  })
}
