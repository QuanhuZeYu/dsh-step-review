/** 复用 DSH 原生工具参数模型与 ToolRow，状态仅作候选预览。 */
import { useMemo } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { StartedToolCall, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCodeOutlineRegular, IconBrowseOutlineRegular, IconApiOutlineRegular, IconEditOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToolRow } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/components/ToolRow.tsx'
import { toolRowModel } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/tool-call-model.ts'
import { readCardModel } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/read-card-model.ts'
import { diffCardModel } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/diff-card-model.ts'
import { searchCardModel } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/search-card-model.ts'
import { webCardModel } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/web-card-model.ts'
const icons = { code: IconCodeOutlineRegular, read: IconBrowseOutlineRegular, bash: IconApiOutlineRegular,
  write: IconEditOutlineRegular, edit: IconEditOutlineRegular, search: IconSearchOutlineRegular, others: IconSparkleRegular }
type Props = Pick<ChatNodeViewProps<'step-review'>, 'cwd' | 'openFile' | 'useDisclosure'> & PropsLocale<'conversation'> & {
  name: string; arguments: string; identity: string; pending?: boolean
}
export function CandidateTool({ name, arguments: argsRaw, identity, pending = false, cwd, openFile, useDisclosure, t }: Props) {
  // 这只是渲染器输入，候选不会写入 tool/call 或 tool/result。
  const block = useMemo<StartedToolCall>(() => ({ phase: 'start', name, callId: identity, argsRaw,
    args: PartialArguments.fromText(argsRaw), turn: 0, step: 0, time: 0, subCalls: [] }), [name, identity, argsRaw])
  const model = useMemo(() => toolRowModel(name, block, cwd), [name, block, cwd])
  const Icon = icons[model.variant]
  // 保留停止态的参数展开能力，仅将待审候选的状态标签改为待审。
  const candidateT: Props['t'] = (key, ...args) => pending && key === 'row.stopped' ? '待审' : t(key, ...args)
  return <div data-step-review-tool>
    <ToolRow useDisclosure={useDisclosure} t={candidateT} variant={model.variant} toolName={name} icon={<Icon size={14} />}
      title={t(model.titleKey)} summary={model.summary} bodyRaw={model.filePath ? null : model.bodyRaw} state='stopped'
      read={readCardModel(block, cwd)} diff={diffCardModel(block)}
      search={searchCardModel(block)} web={webCardModel(block)}
      filePath={model.filePath} onOpenFile={openFile} />
  </div>
}
