# 开发

更新运行产物前先通过插件管理器关闭审查插件包，确认卸载后同步完整产物，再重新启用并回读状态与设置；避免活动审查随热载卸载而中断当前回合。

目标环境：DSH 0.2.2-rc.5、Node >=24.9.0。宿主先按 `patches/README.md` 完成独立审查池与生成计时补丁的构建和重启。源码构建使用已构建的 DSH checkout，复用其原生客户端组件与类型。

~~~text
node scripts/link-dsh.mjs /path/to/deepseek-harness
npm run typecheck
npm run build
~~~

外置插件在独立终端运行 `npm run watch:host` 与 `npm run watch:client`。Host 的 hmr roots 加入本插件真实 lib 目录，并保留原有 roots。客户端 HMR 还需同一 DSH checkout 运行 `dev:web`；其他 Web 变更按宿主构建与刷新流程验证。

宿主目录界面使用独立浏览器构建，配置名带 `/client` 后缀。修改目录分组后，在宿主 checkout 执行 `pnpm --filter @deepseek-ai/dsh-client-ui-subagent run bundle`，核对当前服务发布的插件资源后刷新页面。定向构建只匹配包名会漏掉浏览器产物。

响应关口在缓冲前保留 chunk 原始采样时间，并通过会话插件记录流式展示待审候选。完整候选生成后，为每条命中规则通过原生 spawn 创建独立审查会话。审查可调用 preset 工具取证，主候选等待审查结束。默认 `step-review-reader` 提供只读工具；自定义 preset 定义自己的权限。审查会话须跳过本插件关口以避免递归，主会话取消、插件卸载和总期限触发时应终止对应审查。

`maxConcurrentReviews` 默认 16。共享协调器创建一个宿主 `createCapacityPool(() => number)` 句柄；同一宿主多处挂载采用有效配置中的最小容量，热调整不替换池，名额归还继续由原生 activation 管理。本地子级在当前服务与根 Agent 存活期间保留池绑定供冷恢复；进程重启后的历史恢复回默认工作池，插件审查重新创建。旧宿主缺少接口时停止并提示升级。

`reviewerPreset` 默认 `step-review-reader`；`maxReviewSteps` 默认 12；`timeoutMs` 默认 120000，已有覆盖值继续生效。插件配置不再限制规则数、模式数和字符串长度；步骤、并发和订正次数仅校验安全整数及其下界。超时范围 1–2147483647 毫秒，与 Node.js 计时器一致，前后端共用边界。审查 activation 显式清除父 Agent 的 `maxTokens` 覆盖，让所选模型按原生设置解析输出上限。插件不累计限制响应字节、初始材料与取证字符，成功取证的文件版本仍在放行前复核。模型覆盖和推理等级三态沿用既有契约：空值继承，`null` 使用提供方默认，字符串指定等级。

生成计时由当前 LlmRuntime 实例按请求拥有的旁表维护。adapter 为每次产出建立独立 chunk 身份；插件保留已有采样，未采样的自定义上游对象先复制再标记。通过后放行原对象，原生实时帧与持久流沿用采样时间；生成完成取最后一个 finish 记录时间，无 finish 时回退提交时间。模型生成速度排除审核等待，步骤墙钟和事件提交时间保留完整生命周期。

配置页读取原生 settingsSchema 与 ConfigForms describe 镜像，按修订号原子保存实际变化字段；冲突时保留草稿。preset 目录使用 `remote.agentPresets.list()`，目录不可用时填写 preset id。配置快照在下一次主模型请求读取；仅刷新网页不能替换 Host 模块。

默认 Release 规则检查发布正文及其引用文件。取证失败必须拒绝；先写正文再发布须分成两步。规则只输出局部订正建议，主会话执行修改。审查 Agent 通过原生 `structured_output` 工具提交裁决：

~~~json
{"decision":"reject","reason":"具体问题","suggestions":["局部修改建议"]}
~~~

通过时使用 `decision=pass`。取证义务由本条规则决定：文本结论规则按给定材料判断具体矛盾，未附构建或运行记录不触发全盘追证；Release 等明确要求核验实际文件的规则仍须读取对应材料。步骤额度包含最终结构化裁决。
