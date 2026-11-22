# 开发

目标环境：DSH 0.2.2-rc.5、Node >=24.9.0。

~~~text
node scripts/link-dsh.mjs /path/to/deepseek-harness
npm run typecheck
npm run build
~~~

源码构建使用已构建的 DSH 0.2.2-rc.5 checkout，以复用其原生客户端组件与类型。链接脚本核对依赖真实路径，遇到其他 checkout 的既有依赖会停止并提示。发布包通过 dependencies 与 peerDependencies 获取运行依赖。

外置插件需要自己的构建监听，在两个终端分别运行：

~~~text
npm run watch:host
npm run watch:client
~~~

Host 的原生 hmr 插件须监听本插件的真实 lib 目录，例如在开发 profile 的 cordis.patch.yml 中配置：

~~~yaml
- id: hmr
  config:
    root:
      - C:/path/to/dsh-step-review/lib
~~~

保留已有 watch roots，只增加本插件目录。客户端 HMR 接收器配合同一 DSH checkout 的 dev:web 构建链使用；DSH 的源码扫描不会替外置插件执行上述构建。配置保存走原生 ConfigForms 和 volatile 引用，下一次主模型请求读取新值。服务端代码替换会卸载旧实例并取消其在途审查，应在空闲时进行。

配置页读取原生 settingsSchema 和 describe 镜像，仅将实际改动字段原子保存，避免把所有默认值变成用户覆盖。字段是否支持以 Host schema 为准；版本不匹配时保留可编辑草稿，并明确提示加载新版服务端。仅刷新网页不能替换 Host 模块。

入口：[响应关口](../src/index.ts)、[规则配置](../src/config.ts)、[配置编辑器](../src/client/index.tsx)、[审查卡片](../src/client/ReviewCard.tsx)。

配置页分为基本设置、审查规则和高级设置，使用原生 Input、Switch、Button。规则先显示摘要，展开保留编辑状态。模型与推理等级直接复用原生 ModelSelect，触发器限定为设置表单外观，目录使用 Host 元数据，选择只修改配置草稿。推理等级由 reasoningEffort 保存并传入审查请求；规则继承模型时也继承默认等级，自选模型则使用该模型默认等级。null 表示显式采用提供方默认值，空串和缺省值沿用继承语义。

卡片复用 rc.5 的公开 src 导出：工具参数模型、ToolRow 和 MarkdownText。工具源码与 CSS Modules 在构建期内联，React 和 UI primitives 使用宿主共享模块；升级 DSH 时需同步核对这组接口。完整注入由独立 InjectionContent 组件承载，阅读与原文平级切换；原文默认换行，复制始终使用实际注入字符串。

审查输出固定为 JSON：

~~~json
{"decision":"reject","reason":"具体问题","suggestions":["局部修改建议"]}
~~~

通过使用 decision=pass。规则提示词仅需定义审查标准。
