# 宿主目录分类补丁

此补丁为 DSH 0.2.2-rc.5 增加持久目录分类、工作 Agent 发现过滤和独立“审查”入口。插件安装包不替换宿主模块；需要目录分组时，在 DSH 源码 checkout 应用此补丁。

适用基线：`9c2670d3bce5275e0d1610272958121af87787bb`。其他版本先用 `git apply --check` 检查适用性。宿主已有相同能力时无需重复应用。

在宿主 checkout 执行，将补丁路径替换为实际下载位置：

```sh
git apply --check /path/to/dsh-0.2.2-rc.5-review-catalog.patch
git apply /path/to/dsh-0.2.2-rc.5-review-catalog.patch
pnpm run build
```

独立审查池另需应用 `dsh-0.2.2-rc.5-review-capacity.patch`，其基线是已应用目录分类补丁的宿主（`054f7538b342adfa3eb2224856471b0825419c3a`）。已具备目录分类时只需应用容量池补丁：

```sh
git apply --check /path/to/dsh-0.2.2-rc.5-review-capacity.patch
git apply /path/to/dsh-0.2.2-rc.5-review-capacity.patch
pnpm run build
```

先完成宿主构建，再重启服务并加载插件新产物，最后刷新页面。新插件需要宿主 `createCapacityPool` 接口；审查并发在插件高级设置中调整，默认 16。重启会结束现有运行任务，应在合适时机执行。工作 Agent 与审查会话分别显示；历史审查在身份确认后归类。补丁保留原生权限、运行生命周期和完整会话目录。

目录界面浏览器构建配置名带 `/client` 后缀，定向构建时必须包含该配置；标准完整构建已覆盖。

DSH 代码遵循 MIT 许可证，版权声明见[第三方声明](../THIRD-PARTY-NOTICES)。
