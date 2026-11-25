import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Agents, { agentCarrier, type Agent } from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Directory from '@deepseek-ai/dsh-working-directory'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { ReviewError, safeErrorMessage } from './failure.js'
import { abortable, cleanup } from './review-async.js'
import type { ReviewCoordinator } from './review-coordinator.js'
import { reviewerPresetDefinition } from './reviewer-preset.js'

const readTools = ['read', 'grep', 'glob']
const allowed = new Set([...readTools, 'structured_output'])

/** 复用 Agent 所属代际的作用域路由，同时保留宿主工具服务域筛选。 */
function toolCarrier(tools: Context['tools'], agent: Agent): Scoped<Context['tools']> {
  const carrier = agentCarrier(agent)
  const scopeFilter = Reflect.get(carrier, Context.filter) as (ctx: Context) => boolean
  const serviceFilter = Reflect.get(tools, Context.filter) as ((ctx: Context) => boolean) | undefined
  Object.defineProperty(carrier, Context.filter, { value: (ctx: Context) =>
    (serviceFilter === undefined || serviceFilter.call(tools, ctx)) && scopeFilter.call(carrier, ctx) })
  return carrier as unknown as Scoped<Context['tools']>
}

/** 每次审查拥有独立的 Agent、会话及工具注册表。桥接宿主已有的模型和执行后端。 */
export async function createReviewRuntime(parent: Agent, cwd: string, preset: string, coordinator: ReviewCoordinator, signal: AbortSignal): Promise<Context> {
  if (preset !== reviewerPresetDefinition.id) throw new ReviewError('独立审查需要只读审查 preset：' + reviewerPresetDefinition.id, { code: 'STEP_REVIEW_PRESET_INVALID', stage: 'runtime' })
  const host = parent.ctx
  const llm = host.get('llm')
  const fs = host.get('fs')
  const subprocess = host.get('subprocess')
  const tools = host.get('tools')
  if (!llm || !fs || !subprocess || !tools) throw new ReviewError('独立审查需要宿主模型、文件系统、进程和工具服务', { code: 'STEP_REVIEW_RUNTIME_SERVICES_MISSING', stage: 'runtime' })
  const root = new Context()
  signal.throwIfAborted()
  const initialize = async () => {
    root.baseUrl = import.meta.url
    await root.plugin(Loader)
    signal.throwIfAborted()
    root.loader.builtins.group = Group
    const bridge: Pick<Context['llm'], 'prepareCall' | 'stream' | 'streamChunkTime'> = {
      async prepareCall(...args) {
        signal.throwIfAborted()
        const prepared = await abortable(llm.prepareCall(...args), signal)
        return { ...prepared, stream: request => coordinator.observeStream(request, () => prepared.stream(request)) }
      },
      stream: request => coordinator.observeStream(request, () => llm.stream(request)),
      // 源码宿主可能未提供可选的流式时间戳。
      streamChunkTime: (request, chunk) => llm.streamChunkTime?.(request, chunk),
    }
    root.provide('llm', Object.freeze(bridge))
    root.provide('fs', fs)
    root.provide('subprocess', subprocess)
    await root.plugin(Sessions)
    signal.throwIfAborted()
    await root.plugin(Projections)
    signal.throwIfAborted()
    await root.plugin(Prompt, { personaPrefix: '' })
    signal.throwIfAborted()
    await root.plugin(Tools)
    signal.throwIfAborted()
    await root.plugin(NativeExecutor)
    signal.throwIfAborted()
    await root.plugin(Agents)
    signal.throwIfAborted()
    await root.plugin(Loop, { agents: [] })
    signal.throwIfAborted()
    await root.plugin(Presets, { default: preset })
    signal.throwIfAborted()
    await root.plugin(Directory, { defaultDirectory: cwd })
    signal.throwIfAborted()
    coordinator.attach(root)
    root.on('tools/pre-execute', async (exec, next) => {
      signal.throwIfAborted()
      if (!exec.agent) return { kind: 'deny', reason: '独立审查工具缺少 Agent 身份' }
      const decision = await abortable(host.waterfall(toolCarrier(tools, exec.agent), 'tools/pre-execute', exec, next), signal)
      signal.throwIfAborted()
      return decision.kind === 'ask' ? { kind: 'deny', reason: decision.reason ?? '独立审查不能请求额外权限' } : decision
    }, { global: true, prepend: true })
    root.tools.guard(exec => signal.aborted ? '审查已取消'
      : allowed.has(exec.name) ? tools.checkGuards(exec) : '审查 Agent 仅可读取、搜索并提交结构化裁决')
    await root.agentPresets.register(reviewerPresetDefinition)
    signal.throwIfAborted()
    return root
  }
  try {
    return await abortable(initialize(), signal)
  } catch (error) {
    cleanup(() => root.fiber.dispose(), cause => host.logger.warn('审查运行时启动失败后的资源清理异常 · ' + safeErrorMessage(cause)))
    if (signal.aborted && error === signal.reason) throw error
    throw new ReviewError('初始化审查运行时失败 · ' + safeErrorMessage(error), { code: 'STEP_REVIEW_RUNTIME_INIT_FAILED', stage: 'runtime', cause: error })
  }
}
