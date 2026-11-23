# 宿主补丁

v0.2.3 需要宿主的独立审查池与生成计时接口。插件安装包包含补丁，安装不会自动替换宿主模块。目标环境为 DSH 0.2.2-rc.5 Web。

## 从普通 rc.5 升级

已验证基线为 `9c2670d3bce5275e0d1610272958121af87787bb`。先关闭逐步骤审查插件包，在宿主源码 checkout 按以下顺序检查并应用补丁；将路径替换为实际下载位置：

```sh
git apply --check /path/to/dsh-0.2.2-rc.5-review-catalog.patch
git apply /path/to/dsh-0.2.2-rc.5-review-catalog.patch
git apply --check /path/to/dsh-0.2.2-rc.5-review-capacity.patch
git apply /path/to/dsh-0.2.2-rc.5-review-capacity.patch
git apply --check /path/to/dsh-0.2.2-rc.5-stream-timing.patch
git apply /path/to/dsh-0.2.2-rc.5-stream-timing.patch
pnpm run build
```

完成构建后重启原宿主，再安装 v0.2.3、重新启用插件并刷新页面。重启会结束正在运行的任务。其他源码版本先用 `git apply --check` 核对适用性。

已应用目录分类和容量池补丁的用户，仅需检查并应用计时补丁。已具备全部接口和统计消费者修复的宿主无需重复应用。计时补丁的导出基线为 `8c3f369a72a7e9c784759e32b083f405a14bd7e0`，同时已验证能接续上述公开 rc.5 补丁链。

## 补丁作用

- `review-catalog`：持久审查分类、独立“审查”入口与工作 Agent 发现过滤。
- `review-capacity`：独立审查容量池，默认并发 16，可在插件高级设置调整。
- `stream-timing`：按 LLM 实例与请求保留 chunk 原始采样时间，统一聊天、轨迹和统计的生成完成端点。审核等待保留在步骤墙钟中，排除在生成速度分母之外；旧记录丢失的原始时间无法精确还原。

标准完整构建覆盖客户端资源；定向构建时要包含名称带 `/client` 后缀的浏览器配置。补丁保留原生权限、工具审核关口和会话事件结构。

DSH 代码遵循 MIT 许可证，版权声明见[第三方声明](../THIRD-PARTY-NOTICES)。
