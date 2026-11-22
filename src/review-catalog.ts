/** 审查目录的历史归类只核对已保存身份，不参与实时裁决。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { REVIEWER_PRESET_ID } from './reviewer-preset.js'

function recordedReviewIds(events: readonly SessionEvent[], inherited: number): Set<string> {
  const ids = new Set<string>()
  for (const event of events.slice(inherited)) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'step-review') continue
    for (const result of event.data.source.review?.results ?? []) {
      if (result.reviewerSessionId) ids.add(result.reviewerSessionId)
    }
  }
  return ids
}

/** 原始创建任务与默认 preset 共同确认旧通过项；引用示例不构成身份。 */
function hasOriginalReviewTask(events: readonly SessionEvent[], inherited: number): boolean {
  const first = events.slice(inherited).find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  return first?.type === 'user/message' && first.data.content.some(block => block.type === 'text'
    && block.text.startsWith('你是独立审查 Agent。按给定规则审查候选')
    && block.text.includes('审查规则：') && block.text.includes('待审材料：'))
}

export function registerReviewCatalog(ctx: Context): void {
  const controller = new AbortController()
  const pending = new Map<Agent, Promise<void>>()
  const completed = new WeakSet<Agent>()
  const migrate = async (agent: Agent): Promise<void> => {
    const query = ctx.get('sessionQuery')
    if (!query || !ctx.subagents.setCategory) return
    const signal = controller.signal
    using parent = await query.observeSession(agent.id, { signal })
    const entries = parent.projections?.values.subagentCatalog ?? []
    const known = recordedReviewIds(parent.events, parent.inheritedEventCount)
    const classified = new Set(parent.events.slice(parent.inheritedEventCount)
      .filter(event => event.type === 'subagent/catalog-category').map(event => event.data.childId))
    let incomplete = false
    for (const entry of entries) {
      signal.throwIfAborted()
      if (classified.has(entry.id) || (entry.category ?? 'work') !== 'work' || entry.mode === 'external') continue
      let confirmed = known.has(entry.id)
      if (!confirmed && entry.label?.startsWith('逐步骤审查：')) {
        try {
          using child = await query.observeSession(entry.id, { signal, projectionMode: 'none' })
          confirmed = child.header.parentSession === agent.id
            && child.header.agentPreset === REVIEWER_PRESET_ID
            && hasOriginalReviewTask(child.events, child.inheritedEventCount)
        } catch {
          signal.throwIfAborted()
          incomplete = true
          continue
        }
      }
      signal.throwIfAborted()
      if (confirmed) {
        // 子会话核对期间可能已有明确分类；在同步写入前重新读取父日志，迁移不覆盖它。
        const explicitlyClassified = agent.session.snapshotEvents().slice(parent.inheritedEventCount)
          .some(event => event.type === 'subagent/catalog-category' && event.data.childId === entry.id)
        if (!explicitlyClassified) ctx.subagents.setCategory(agent.session, entry.id, 'review')
      }
    }
    if (incomplete) ctx.logger.warn('部分历史审查会话尚不能核对，保留原分类：' + agent.id)
    else completed.add(agent)
  }
  const schedule = (agent: Agent): void => {
    if (controller.signal.aborted || completed.has(agent) || pending.has(agent)) return
    const task = migrate(agent).catch(() => {
      // 历史展示归类失败不停止新审查，下一次请求仍可重试；不输出外来异常正文。
      if (!controller.signal.aborted) ctx.logger.warn('审查目录历史归类未完成，会话：' + agent.id)
    }).finally(() => { pending.delete(agent) })
    pending.set(agent, task)
  }
  ctx.on('agent/created', ({ agent }) => { schedule(agent) })
  ctx.on('llm/stream', (request, next) => {
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    if (agent) schedule(agent)
    return next()
  })
  ctx.effect(() => {
    // 不在宿主 apply 中等待查询，避免与 Loader 激活互等。
    queueMicrotask(() => { for (const agent of ctx.agents.list()) schedule(agent) })
    return async () => {
      controller.abort()
      await Promise.all([...pending.values()])
    }
  })
}
