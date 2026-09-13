# 导出与队列提示补充调整

用户在 I8 后新增三项要求，本记录先登记范围，再逐项实施；不改写 I8 的历史验证快照。

| 项目 | 实现与验收 | 状态 |
| --- | --- | --- |
| 底栏批量下载菜单 | 与批量操作一致，向上展开、左边对齐；预览标题区菜单仍向下靠右 | 已实现 |
| 同名文件处理 | 导出配置增加自动添加序号 / 覆盖同名文件，默认序号；单份、批量、来源目录、自选目录使用同一策略；检查结果显示策略，修改后重新检查 | 已实现 |
| 队列操作提示 | 查看字幕、打开文件夹、停止、删除仅显示动作，不拼接文件名 | 已实现 |

## 实现边界

- 保留导出快照、版本、授权窗口、来源绑定与原始文件名规则。
- 自动序号继续使用排他发布，避免并发导出互相覆盖。
- 新的显式覆盖使用项目已验证的原生目录句柄事务，拒绝链接与非普通文件；不扩大旧的路径 rename 覆盖入口。
- 覆盖来源字幕本身后更新来源绑定，保证后续导出仍可使用来源目录。原始文档内容仍由文档库保留。
- 批量导出中同一目的路径的重复项继续加序号，避免本批次文件互相覆盖；覆盖选项针对此前已存在的文件。
- 不涉及转写执行器覆盖策略、打包演练或提交推送。
- 本次配置作用于“导出字幕”；“下载原文件”保留已有原始字节下载语义。

## 代码落点

- `StudioExport.tsx`：批量菜单定位、两列表单选项、检查页策略摘要；四语言同步。
- `export-contract.ts`：可选的严格枚举，省略时按自动序号执行，选项属于不可变导出计划。
- `export-service.ts` / `batch-service.ts` / 主进程 IPC：来源及手选位置一致执行策略，本批次同目标去重。
- `export-overwrite.ts`：加载已校验的原生模块，目录身份和临时文件身份绑定，原子安装、完成并确认事务。
- `source-location-service.ts` / `document-repository.ts`：在文档串行锁内刷新被本次覆盖的来源身份并轮换绑定 ID，旧计划不能沿用旧绑定。
- `StudioTranscription.tsx`：动作 Tooltip 不附带文件名，文件名自身的完整提示不变。

## 验证

77 项针对性回归已通过：`export-service.test.ts`（23）、`batch-service.test.ts`（7）、`acceptance-source-output.test.ts`（23）、`ipc.test.ts`（24）。包括快照冻结、授权/版本、来源变更、并发序号及故障清理。

新增 `export-conflict-ui.test.ts` 使用真实 Electron、main/preload 和 Windows 原生模块，隔离配置与合成字幕；验证自动序号保留旧文件、来源覆盖、来源绑定刷新、手选重名路径、连续再次导出、批量重名序号、目录目标拒绝和临时文件清理。使用原生实现而非路径 rename，是应用 FK-PIT-0056 的结果。

最终实际验证通过：

| 检查 | 结果与证据 |
| --- | --- |
| 导出及菜单 Electron | `test-results/studio-export-conflict/electron.log`，11 秒通过；输出目录 `run-wcCjU4`，含菜单、设置、覆盖确认与窄窗口深色截图、`result.json`、`cleanup.json` |
| 队列 Electron | `test-results/studio-export-conflict/queue.log`，22 秒通过；`test-results/studio-t06-ui/controlled-co6AXB/i6-queue-result.json`，深浅主题动作提示精确匹配、28px ghost 按钮及键盘停止/删除通过，pageErrors 为空 |
| 截图审阅 | 已查看最终菜单、宽屏设置、窄窗口深色设置、深色队列动作 Tooltip；文件名未进入动作提示，菜单锚点和表单列宽正常 |
| 类型 | `types.log` 为空，包含 src/electron 与两份修改的 Electron 验证脚本 |
| 构建 | `build.log`：renderer、main、preload 构建完成；保留既有大包提示 |
| 边界与 preload | `boundary.json`：428 文件、0 错误；`preload.log` 通过 |
| 多语言 | 四语言完整性通过，`i18n-usage.log` 全部引用可解析；原有翻译相同值提示不影响结果 |
| 文档和补丁 | spec done/check-overall 0 错误、0 警告；diff --check 无空白错误 |

队列第一次复验在深色重载后未达到测试目标窗口尺寸，已在测试中恢复原生窗口并等待实际尺寸一致后继续，未放宽尺寸断言。最终两主题通过；临时 Electron/profile 均已清理，进程核对见 `process-audit.json`。

三项已完成，尚未提交或推送。本轮源码、构建及主要证据指纹见 `2026-09-13-export-followup.snapshot.json`。

## 验证边界

本机验证为 Windows x64 Electron；未进行 macOS 或打包演练。原生事务故障时保留未收敛的恢复标记，不删除备份或反转已经开始的终结决定；本次不新增跨进程导出恢复界面。旧 I8 快照只证明当时版本，本补充以本轮测试输出为准。
