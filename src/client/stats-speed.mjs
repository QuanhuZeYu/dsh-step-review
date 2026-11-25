/** 包装当前版本原统计表的注册，只校正有放行记录佐证的输出速度。 */
export function wrapStatistics(require, original) {
  const { createElement, useMemo } = require('react')
  const releaseType = 'plugin:step-review/preview'

  function validRelease(event, output, settledAt) {
    const { timing, previewId } = event.data
    if (typeof previewId !== 'string' || previewId === '' || timing == null || output <= 0
      || !Number.isSafeInteger(output) || timing.outputTokens !== output) return null
    const { startedAt, firstTokenAt, finishedAt, releasedAt } = timing
    if (![startedAt, firstTokenAt, finishedAt, releasedAt].every(t => Number.isSafeInteger(t) && t >= 0)
      || startedAt > firstTokenAt || firstTokenAt >= finishedAt || finishedAt > releasedAt
      || releasedAt > event.time || event.time > settledAt) return null
    return finishedAt - firstTokenAt
  }

  // 与当前版本 sessionStats 投影使用同样的持久化流首输出规则。
  function firstToken(stream) {
    for (const record of stream ?? []) {
      if (record.type === 'chunk') {
        const chunk = record.chunk
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          if (chunk.text !== '') return record.time
        } else if (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined)) {
          return record.time
        }
        continue
      }
      const isTool = record.type === 'tool-call-chunks'
      if (isTool && record.name !== undefined) return record.time0
      const fragments = isTool ? record.args : record.texts
      let time = record.time0
      for (let index = 0; index < (fragments?.length ?? 0); index += 1) {
        if (index > 0) time += record.dt[index - 1]
        if (fragments[index] !== '') return time
      }
    }
    return undefined
  }

  function correctionSamples(entries) {
    const samples = new Map()
    const pending = new Map()
    let open
    for (const { type, event } of entries) {
      if (type !== 'event' || !event.data) continue
      const { data } = event
      const key = data.turn + ':' + data.step
      switch (event.type) {
        case 'step/start':
          pending.delete(key)
          open = { key, time: event.time, first: undefined }
          break
        case releaseType:
          if (data.version !== 1) break
          if (data.phase === 'released') pending.set(key, event)
          else pending.delete(key)
          break
        case 'assistant/attempt':
          pending.delete(key)
          if (open?.key === key) open.first ??= firstToken(data.stream)
          break
        case 'llm/retry':
          pending.delete(key)
          break
        case 'step/end':
          pending.delete(key)
          if (open?.key === key) open = undefined
          break
        case 'assistant/message': {
          const release = pending.get(key)
          pending.delete(key)
          const step = open?.key === key ? open : undefined
          if (step) open = undefined
          const output = data.usage?.outputTokens
          const ms = release ? validRelease(release, output, event.time) : null
          if (ms === null || samples.has(key) || (step && release.data.timing.startedAt < step.time)) break
          const previousFirst = step && (step.first ?? firstToken(data.stream))
          samples.set(key, {
            output, ms,
            projectionDelta: !step ? null : previousFirst === undefined
              ? { tokens: output, ms } : { tokens: 0, ms: ms - Math.max(0, event.time - previousFirst) },
          })
          break
        }
      }
    }
    return samples
  }

  function correct(snapshot, samples) {
    if (samples.size === 0) return { snapshot, deltaMs: 0, deltaTokens: 0 }
    let changed = false
    let deltaMs = 0
    let deltaTokens = 0
    const turns = snapshot.turns.map(turn => {
      let ms = 0
      let tokens = 0
      let turnChanged = false
      const steps = turn.steps.map(step => {
        const sample = samples.get(turn.turn + ':' + step.step)
        const usable = sample?.output === step.output ? sample : undefined
        const output = step.output
        const duration = usable?.ms ?? step.decode
        if (output > 0 && duration > 0) {
          tokens += output
          ms += duration
        }
        if (!usable) return step
        turnChanged = true
        if (usable.projectionDelta) {
          deltaMs += usable.projectionDelta.ms
          deltaTokens += usable.projectionDelta.tokens
        }
        return { ...step, decode: usable.ms, tps: output * 1000 / usable.ms }
      })
      if (!turnChanged) return turn
      changed = true
      return { ...turn, steps, decode: ms, tps: ms > 0 ? tokens * 1000 / ms : null }
    })
    return { snapshot: changed ? { ...snapshot, turns } : snapshot, deltaMs, deltaTokens }
  }

  function wrapView(OriginalStats) {
    return function CorrectedStats({ useEvents, useStats, useProjection, ...props }) {
      const window = useEvents(value => value)
      const snapshot = useStats(value => value)
      const samples = useMemo(() => correctionSamples(window.entries), [window])
      const corrected = useMemo(() => correct(snapshot, samples), [snapshot, samples])
      function useCorrectedProjection(key) {
        const native = useProjection(key)
        if (key !== 'sessionStats' || !native || (corrected.deltaMs === 0 && corrected.deltaTokens === 0)) return native
        const decodeMs = native.decodeMs + corrected.deltaMs
        const decodeTokens = native.decodeTokens + corrected.deltaTokens
        return decodeMs < 0 || decodeTokens < 0 ? native : { ...native, decodeMs, decodeTokens }
      }
      return createElement(OriginalStats, {
        ...props,
        useStats: select => select(corrected.snapshot),
        useProjection: useCorrectedProjection,
      })
    }
  }

  if (typeof original?.apply !== 'function') throw Error('原统计模块缺少注册入口')
  return {
    ...original,
    apply(ctx) {
      const slots = new Proxy(ctx.slots, {
        get(target, key) {
          if (key === 'register') return (options, component) => {
            if (options.name !== 'conversation.view' || options.id !== 'stats') return target.register(options, component)
            return target.register({ ...options, inject(sessionId) {
              const face = options.inject(sessionId)
              return { ...face, hooks: { ...face.hooks, events: ctx.sessions.binding(sessionId).eventSource } }
            } }, wrapView(component))
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return original.apply(new Proxy(ctx, {
        get(target, key) {
          if (key === 'slots') return slots
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }))
    },
  }
}
