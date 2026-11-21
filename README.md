# 逐步骤审查

按规则检查模型回复和工具参数，减少提交说明中的对话残留与冗余表达。拒绝后交回原会话订正，通过后发布回复、执行工具。

- 内置提交说明、表达清晰度两条规则。
- 支持关键词、正则匹配；提示词、审查模型和推理等级可单独配置。
- 保存后热更新，后续请求使用新配置。
- 拒绝记录对应展示候选内容与订正反馈，代码沿用 DSH 原生渲染。

## 安装

适用于 DSH 0.2.2-rc.5 的 Web 界面和 Node.js 24.9 或以上版本。从 [GitHub Releases](https://github.com/QuanhuZeYu/dsh-step-review/releases) 获取已构建的安装包：

~~~sh
dsh plugin --profile web add https://github.com/QuanhuZeYu/dsh-step-review/releases/download/v0.1.0/dsh-step-review-0.1.0.tgz
~~~

安装后在 DSH Web 的「插件 → 逐步骤审查」打开配置。若运行中的宿主未加载新版插件，请重启宿主。

## 使用

选择审查模型 → 按需编辑规则 → 勾选“启用审查” → 保存并生效。

审查默认关闭。启用后回复会先缓冲；命中规则才调用审查模型。超时、故障或达到订正上限时停止当前回合并留下反馈。

提交规则检查工具参数中的说明；外部脚本或文件中的内容可能缺少可审材料。

命中规则时，相关回复或工具参数会发送给所选审查模型。「提供最近一条用户请求」默认关闭。请根据数据敏感程度选择提供方。

[开发说明](docs/development.md) · [MIT 许可证](LICENSE) · [第三方声明](THIRD-PARTY-NOTICES)
