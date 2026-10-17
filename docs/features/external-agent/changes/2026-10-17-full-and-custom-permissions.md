# 变更：完全开放与自定义权限、右上角连接面板

日期：2026-10-17

## 来源与分类

原始请求：2026-10-17 用户反馈「明明已经选了“自动执行”的权限模式，但还是有很多/经常需要手动点允许来授权的操作，尤其是重命名文件……需要一种能够完全开放权限给外部Agent的模式……或者还可以另外做一个自定义配置权限的模式……相当于每种操作都对应一个权限码」，以及标题栏外部 Agent 指示「放在右上角」「点击后动画过渡成为一个展开的中小型面板」。

类型：behavior-change（扩展 R-SETTINGS 的权限档位与 R-ACTIVITY 的标题栏入口）。

## 行为

- 权限档位由三档增为五档：`read_only`、`confirm_writes`（默认）、`auto`、`full`、`custom`。
- `full`：所有修改直接执行，包括 `rename_paths`、`undo_name_changes`、`prepare_knowledge_changes` 与覆盖已有文件；在设置中选择时弹出一次确认。活动记录的放行方式为 `full`。
- `custom`：每个会修改内容的工具对应一个权限码（与工具名相同），另加 `overwrite_files`；每个码取 `deny` / `ask` / `allow`。替换已有文件的调用取工具本身与 `overwrite_files` 中更严格的一个，且不接受“本次连接内放行”。`deny` 在主进程就拒绝（错误码 `not_permitted`，放行方式 `not_permitted`），`allow` 的记录放行方式为 `permitted`。默认值与 `auto` 相同（知识资料、重命名、撤销重命名、覆盖需批准，其余允许）。切换到其他档位时自定义选择保留。
- 设置保存在 `settings.json` 的 `permissions` 字段，逐码回退：缺失或无效的码用默认值，不影响其他码；更新只改传入的码。
- `get_fusionkit_status` 在 `custom` 时返回 `permissions`；工具说明、连接说明与随附 Skill 不再写“总是确认”。
- 标题栏指示移到右上角，悬停有底色反馈；点击后原地变形为面板（连接、最近一次调用、当前权限、待确认数、查看活动记录与设置入口），Esc、点击外部或关闭按钮收起；面板展开时右上角提示下移让位。
- 活动页左侧连接列表的滚动上限改设在 viewport 上，修复列表越过面板底栏、与“清空记录”重叠的问题。

## 实施与证据

- 代码：`src/agent/external/contract.ts`、`approval.ts`、`confirmations.ts`、`activity*.ts`、`catalog.ts`、`instructions.ts`、`tools/status.ts`，`electron/main/external-agent/index.ts`、`settings-store.ts`，`src/pages/Setting/components/ExternalAgentPermissions.tsx`、`ExternalAgentConfig.tsx`，`src/pages/components/ExternalAgentIndicator.tsx`、`AppTitleBar.tsx`，`src/pages/ExternalAgentActivity/SessionList.tsx`，4 种语言。
- 测试：`src/agent/external/approval.test.ts`（full / custom / 权限码与工具一一对应）、`test/external-agent/settings-store.test.ts`（逐码合并与回退）、`test/external-agent-settings.electron.test.ts`（界面选择自定义、拒绝的操作返回 `not_permitted`、完全开放的确认）、`test/external-agent-activity.electron.test.ts`（面板展开、Esc 收起、进入活动页）；6 个外部 Agent Electron 测试与 provenance 测试通过。
