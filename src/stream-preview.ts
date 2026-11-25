/** 将待审响应写为展示信息记录；原始流与工具调度由调用方继续保管。 */
import { randomUUID } from 'node:crypto'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import { previewRecordType, type PreviewPart, type PreviewPhase, type PreviewRecord, type PreviewTiming } from './preview-types.js'
import type { Candidate } from './types.js'

const FLUSH_INTERVAL_MS = 50
const FLUSH_TEXT_LIMIT = 8192

type PartKind = PreviewPart['kind']
interface PartBuffer {
  kind: PartKind
  fragments: string[]
  name?: string
  replace?: boolean
}

export class ReviewPreview {
  readonly id = randomUUID()
  private phase: PreviewPhase = 'generating'
  private closed = false
  private readonly parts = new Map<number, PartBuffer>()
  private readonly ended = new Set<number>()
  private readonly pending = new Map<number, PartBuffer>()
  private pendingSize = 0
  private timer?: ReturnType<typeof setTimeout>
  private disabled = false
  private readonly startedAt = Date.now()
  private firstTokenAt?: number
  private finishedAt?: number
  private releasedAt?: number
  private outputTokens?: number

  constructor(private readonly session: Session, private readonly turn: number, private readonly step: number, private readonly warn: (error: unknown) => void = () => {}) {
    this.append({ phase: 'generating' })
  }

  /** 保存可见增量并采样首个有效内容；usage 由调用方在流结束后提供。 */
  push(chunk: StreamChunk): void {
    if (this.disabled || this.closed || this.phase !== 'generating') return
    const content = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text
      : chunk.type === 'tool-call-delta' ? chunk.argumentsDelta || chunk.name : undefined
    if (this.firstTokenAt === undefined && content) this.firstTokenAt = Date.now()
    switch (chunk.type) {
      case 'finish':
        this.finishModel()
        break
      case 'block-start':
        if (!this.parts.has(chunk.index) && this.isVisible(chunk.blockType)) {
          this.update(chunk.index, chunk.blockType, '')
        }
        break
      case 'text-delta':
      case 'reasoning-delta':
        if (!this.ended.has(chunk.index)) {
          this.update(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning', chunk.text)
        }
        break
      case 'tool-call-delta':
        if (!this.ended.has(chunk.index)) this.update(chunk.index, 'tool-call', chunk.argumentsDelta, chunk.name)
        break
      case 'block-end': {
        if (this.ended.has(chunk.index)) break
        this.ended.add(chunk.index)
        const block = chunk.block
        if (block.type === 'text' || block.type === 'reasoning') {
          this.update(chunk.index, block.type, block.text, undefined, true)
        } else if (block.type === 'tool-call') {
          this.update(chunk.index, 'tool-call', block.arguments, block.name, true)
        }
        break
      }
    }
    if (!this.pending.size) return
    if (this.pendingSize >= FLUSH_TEXT_LIMIT) this.flush()
    else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.disabled || this.closed || this.phase !== 'generating') return
        try { this.flush() } catch (error) { this.disable(error) }
      }, FLUSH_INTERVAL_MS)
      this.timer.unref()
    }
  }

  /** 记录模型完成采样，沿用上游提供的真实输出 token 用量。 */
  finishModel(outputTokens?: number): void {
    this.finishedAt ??= Date.now()
    if (outputTokens !== undefined) this.outputTokens = outputTokens
  }

  /** 首次审核保存完整快照；后续规则只写阶段与规则标识。 */
  reviewing(candidate: Candidate, ruleId?: string, reviewerSessionId?: string): void {
    this.finishModel()
    this.stopTimer()
    if (this.closed || this.isTerminal()) return
    this.flush()
    this.append({
      phase: 'reviewing',
      ...(ruleId === undefined ? {} : { ruleId }),
      ...(reviewerSessionId === undefined ? {} : { reviewerSessionId, parentSessionId: this.session.id }),
      ...(this.phase === 'generating' ? {
        snapshot: this.materialize(this.parts),
        candidate: { text: candidate.text, tools: candidate.tools.map(tool => ({ name: tool.name, arguments: tool.arguments })) },
      } : {}),
    })
    this.phase = 'reviewing'
    this.parts.clear()
    this.ended.clear()
  }

  release(): void {
    this.finish('released')
  }

  cancel(): void {
    this.finish('cancelled')
  }

  /** 展示写入失败只关闭展示，业务结果由主关口决定。 */
  close(): void {
    this.stopTimer()
    if (this.closed) return
    try {
      if (!this.isTerminal()) this.cancel()
    } finally {
      this.closed = true
      this.parts.clear()
      this.pending.clear()
      this.ended.clear()
      this.pendingSize = 0
    }
  }

  private finish(phase: 'released' | 'cancelled'): void {
    this.stopTimer()
    if (this.closed || this.isTerminal()) return
    this.flush()
    if (phase === 'released') this.releasedAt = Date.now()
    this.append({ phase })
    this.phase = phase
    this.parts.clear()
    this.ended.clear()
  }

  private update(index: number, kind: PartKind, text: string, name?: string, replace = false): void {
    const current = this.parts.get(index)
    const full: PartBuffer = replace || !current || current.kind !== kind ? { kind, fragments: [] } : current
    full.fragments.push(text)
    if (name !== undefined) full.name = name
    this.parts.set(index, full)

    const previous = this.pending.get(index)
    const delta: PartBuffer = replace || !previous || previous.kind !== kind ? { kind, fragments: [] } : previous
    delta.fragments.push(text)
    if (name !== undefined) delta.name = name
    if (replace) delta.replace = true
    this.pending.set(index, delta)
    this.pendingSize += text.length
  }

  private flush(): void {
    this.stopTimer()
    if (!this.pending.size) return
    this.append({ phase: this.phase, parts: this.materialize(this.pending) })
    this.pending.clear()
    this.pendingSize = 0
  }

  private materialize(parts: Map<number, PartBuffer>): PreviewPart[] {
    return Array.from(parts, ([index, part]) => ({
      index, kind: part.kind, text: part.fragments.join(''),
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.replace ? { replace: true } : {}),
    }))
  }

  private timing(): PreviewTiming {
    return { startedAt: this.startedAt, ...(this.firstTokenAt === undefined ? {} : { firstTokenAt: this.firstTokenAt }),
      ...(this.finishedAt === undefined ? {} : { finishedAt: this.finishedAt }),
      ...(this.releasedAt === undefined ? {} : { releasedAt: this.releasedAt }),
      ...(this.outputTokens === undefined ? {} : { outputTokens: this.outputTokens }) }
  }

  private append(data: Pick<PreviewRecord, 'phase' | 'parts' | 'snapshot' | 'candidate' | 'ruleId' | 'reviewerSessionId' | 'parentSessionId' | 'timing'>): void {
    if (this.disabled) return
    try {
      appendPluginRecord(this.session, previewRecordType, {
        version: 1, previewId: this.id, turn: this.turn, step: this.step, ...data, timing: this.timing(),
      })
    } catch (error) { this.disable(error) }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private disable(error: unknown): void {
    if (this.disabled) return
    this.disabled = true
    this.stopTimer()
    this.parts.clear()
    this.pending.clear()
    this.ended.clear()
    this.pendingSize = 0
    this.warn(error)
  }

  private isTerminal(): boolean {
    return this.phase === 'released' || this.phase === 'cancelled'
  }

  private isVisible(kind: string): kind is PartKind {
    return kind === 'text' || kind === 'reasoning' || kind === 'tool-call'
  }
}
