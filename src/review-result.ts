/** 审查 Agent 自有的裁决工具：最终工具结果成功后才提交裁决。 */
import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { ReviewError } from './failure.js'
import type { Verdict } from './types.js'

export const verdictSchema: ObjectJsonSchema = {
  type: 'object', properties: {
    decision: { type: 'string', enum: ['pass', 'reject'] },
    reason: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } },
  }, required: ['decision', 'reason', 'suggestions'], additionalProperties: false,
}

/** schema 校验之外，拒绝还必须有可供原会话订正的原因与建议。 */
export function validateVerdict(value: unknown): Verdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewError('审查结果必须是结构化对象', { code: 'STEP_REVIEW_VERDICT_INVALID', stage: '裁决校验' })
  const v = value as Record<string, unknown>
  if ((v.decision !== 'pass' && v.decision !== 'reject') || typeof v.reason !== 'string'
    || !Array.isArray(v.suggestions) || v.suggestions.some(s => typeof s !== 'string')) throw new ReviewError('审查结果字段不符合协议', { code: 'STEP_REVIEW_VERDICT_INVALID', stage: '裁决校验' })
  if (v.decision === 'reject' && (!v.reason.trim() || !v.suggestions.some(s => String(s).trim()))) throw new ReviewError('拒绝结果缺少原因或修改建议', { code: 'STEP_REVIEW_VERDICT_INCOMPLETE', stage: '裁决校验' })
  return { decision: v.decision, reason: v.reason, suggestions: [...v.suggestions] as string[] }
}

export interface ReviewResult {
  captured(): Verdict | undefined
}

/** 只使用公开工具扩展点；注册和监听均随 Agent scope 释放。 */
export function attachReviewResult(ctx: Context, signal: AbortSignal, canComplete: () => boolean): ReviewResult {
  const staged = new Map<ToolExecution, Verdict>()
  let pending: { parent: ToolExecution['token']; verdict: Verdict } | undefined
  let captured: Verdict | undefined

  ctx.tools.register({
    name: 'structured_output',
    description: '提交最终审查裁决。参数必须符合 schema；仅此工具的成功调用可以结束审查。',
    parameters: { ...verdictSchema },
    output: {
      schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false },
      render: () => [{ type: 'text', text: '审查裁决已记录。' }],
    },
    async execute(args, exec): Promise<{ recorded: true }> {
      signal.throwIfAborted()
      const violations = validateJsonSchemaValue(verdictSchema, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      if (!canComplete()) throw new ReviewError('请先处理待收消息，再提交审查裁决', { code: 'STEP_REVIEW_INBOX_PENDING', stage: '裁决提交' })
      const verdict = validateVerdict(args)
      staged.set(exec, verdict)
      exec.concludeTurn()
      return { recorded: true }
    },
  })
  ctx.systemPrompt.section({
    name: 'tool:structured_output',
    order: ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: '完成判断后必须调用 structured_output 提交 decision、reason、suggestions。普通文本或 JSON 文本不算裁决。',
  })
  // 暂存、PTC 外层待确认和已提交期间均关闭后续工具，避免同一步追加动作。
  ctx.tools.guard(() => signal.aborted ? '审查已取消'
    : staged.size > 0 || pending !== undefined || captured !== undefined ? '审查裁决已提交，不能再执行工具' : undefined)
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'structured_output') {
      const verdict = staged.get(exec)
      if (verdict === undefined) return
      staged.delete(exec)
      if (result.isError || signal.aborted) return
      if (exec.parent === undefined) {
        captured ??= verdict
      } else if (captured === undefined && pending === undefined) {
        pending = { parent: exec.parent, verdict }
      }
      return
    }
    // 内层成功不等于整段程序成功；外层抛错、取消或 post-execute 改错均丢弃暂存。
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (!result.isError && !signal.aborted) captured ??= entry.verdict
  })
  ctx.effect(() => () => { staged.clear(); pending = undefined; captured = undefined })
  return { captured: () => captured }
}