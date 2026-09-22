# 无法恢复文档的批量清理

## 体验

处理弹窗新增逐项勾选、全选/取消全选、已选数量和“清理所选”。用户只需确认一次；单项清除与查看保存位置继续可用。确认说明、清理进度和结果位于固定底栏。部分失败不会阻断其余文档，失败项保留并标记，可以再次选择或单独重试。

## 实现边界

- 复用既有 `deleteUnavailable` IPC，按顺序执行。没有新增按路径直接删除或绕过主进程校验的接口。
- 打开确认时冻结确切的文档 ID 和 token。刷新后新出现的文档不进入已确认批次；数据发生变化或已恢复可读时由主进程拒绝删除。
- 同步 operation guard 阻止重复确认；处理期间禁用选择、删除、查看和关闭操作。
- 成功项立即从当前弹窗移除；累计 cleanupPending，结束时刷新列表并汇总成功/失败数。
- 选择与删除授权绑定 ID+token，失败提示绑定稳定 ID，避免 token 刷新后丢失失败标记。
- 确认时焦点落到取消，完成后回到关闭。四种语言文案同步。

## 验证与视觉复查

- TypeScript、i18n locale/source usage、renderer/main/preload 构建通过。
- Repository 26 项和 IPC 34 项通过；真实 Electron 新增验收 1 项通过。
- Electron 使用隔离 profile 和真实无效文档目录，覆盖多选、全选混合态、取消不删除、一次确认、重复点击、过期 token 的逐项隔离、确认后新出现文件保留、失败项重试、单项清除、全部清空。
- 校验正常工作台文档、原字幕文件、导出文件均保留。
- 审查 1280×860 浅色选择/失败结果及 786×540 深色确认截图。首次复查发现失败标记随 token 刷新消失，修正后重跑并确认结果。
- 窄窗口从页面提示入口打开弹窗；不使用只在宽窗口存在的 aside 定位器。
- 截图位于 `test-results/studio-recovery-batch/`：`selection-light.png`、`partial-failure-light.png`、`confirmation-narrow-dark.png`。均等待 loading 层退出后获取并实际查看。
- 测试通过 finally 关闭隔离 Electron 并删除临时 profile；本轮未启动常驻 Vite 服务。

主要代码：`StudioRecovery.tsx`、`studio.css`、四语言 `studio.json`；新增回归：`test/subtitle-studio/recovery-batch-ui.test.ts`。
