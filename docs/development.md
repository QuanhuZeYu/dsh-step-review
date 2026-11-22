# 开发

目标环境：DSH 0.2.2-rc.5、Node >=24.9.0。源码构建使用已构建的 DSH checkout，复用其原生客户端组件与类型。

~~~text
node scripts/link-dsh.mjs /path/to/deepseek-harness
npm run typecheck
npm run build
~~~

外置插件在独立终端运行 `npm run watch:host` 与 `npm run watch:client`。Host 的 hmr roots 加入本插件真实 lib 目录，并保留原有 roots。客户端 HMR 还需同一 DSH checkout 运行 `dev:web`；其他 Web 变更按宿主构建与刷新流程验证。

宿主目录界面使用独立浏览器构建，配置名带 `/client` 后缀。修改目录分组后，在宿主 checkout 执行 `pnpm --filter @deepseek-ai/dsh-client-ui-subagent run bundle`，核对当前服务发布的插件资源后刷新页面。定向构建只匹配包名会漏掉浏览器产物。

响应关口先缓冲主候选，再为每条命中规则通过原生 spawn 创建独立审查会话。审查可调用 preset 工具取证，主候选等待审查结束。默认 `step-review-reader` 提供只读工具；自定义 preset 定义自己的权限。审查会话须跳过本插件关口以避免递归，主会话取消、插件卸载和总期限触发时应终止对应审查。

`reviewerPreset` 默认 `step-review-reader`；`maxReviewSteps` 默认 12，范围 1–64；`timeoutMs` 默认 120000，已有覆盖值继续生效。`maxReviewTokens` 默认 16384，限制每次审查模型响应。模型覆盖和推理等级三态沿用既有契约：空值继承，`null` 使用提供方默认，字符串指定等级。

配置页读取原生 settingsSchema 与 ConfigForms describe 镜像，按修订号原子保存实际变化字段；冲突时保留草稿。preset 目录使用 `remote.agentPresets.list()`，目录不可用时填写 preset id。配置快照在下一次主模型请求读取；仅刷新网页不能替换 Host 模块。

默认 Release 规则检查发布正文及其引用文件。取证失败必须拒绝；先写正文再发布须分成两步。规则只输出局部订正建议，主会话执行修改。审查 Agent 通过原生 `structured_output` 工具提交裁决：

~~~json
{"decision":"reject","reason":"具体问题","suggestions":["局部修改建议"]}
~~~

通过时使用 `decision=pass`。规则提示词仅定义审查标准。
