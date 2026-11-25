/** 插件自带的审查组合：复用原生读取、搜索和 native 执行器。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'

export const REVIEWER_PRESET_ID = 'step-review-reader'

/** 由主插件注册，确保已有安装在重新加载时也能取得默认审查组合。 */
export const reviewerPresetDefinition: PresetDefinition = {
  id: REVIEWER_PRESET_ID,
  name: '逐步骤只读审查',
  description: '读取、搜索材料并提交结构化审查裁决。',
  plugins: [{
    id: 'step-review-reader',
    name: new URL('./reviewer-preset.js', import.meta.url).href,
  }],
}

export const name = 'step-review-reader'
export const inject = ['tools', 'fs', 'subprocess', 'systemPrompt', 'workingDirectory']

const readTools = ['read', 'grep', 'glob']
const executableTools = new Set([...readTools, 'structured_output'])

/** 由 agent-preset 的 plugins 挂载，所有贡献随该 preset 代际释放。 */
export async function apply(ctx: Context): Promise<void> {
  // 由工具服务校验其实际作用域，避免热重载后的私有 Symbol 代际差异。
  const release = ctx.tools.restrict({ allow: [] })
  release()

  await ctx.plugin(FileTools, { read: true, readImage: false, write: false, edit: false, applyPatch: false })
  await ctx.plugin(SearchTools, { sampleOverCapGlobResults: false })
  await ctx.plugin(NativeExecutor)

  // preset 工具在 Agent 视图中属于继承工具，须等 Agent 已绑定后设置过滤。
  // 子 Agent 自身注册的原生 structured_output 具有独立 scope，保留真实输出 schema。
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: readTools })
    return undefined
  })

  // 原生过滤器豁免 Agent 自身注册；执行 guard 同时约束这条扩展路径。
  ctx.tools.guard(exec => executableTools.has(exec.name)
    ? undefined
    : '审查 Agent 仅可读取、搜索并提交结构化裁决')
}
