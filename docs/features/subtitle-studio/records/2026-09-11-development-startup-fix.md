# I1 开发启动与历史文档错误隔离修复

日期：2026-09-11（Asia/Shanghai）。基线：`002be2d` 后的本轮工作树。范围：用户报告的 Windows `pnpm dev` 启动扫描错误、字幕工作台进入即报错和文件选择按钮失效；不进入 I2。

## 复现与原因

用户日志明确显示 Vite 默认扫描了应用以外的 HTML：发布目录、测试报告、FFmpeg 文档及 `scripts/local-subtitle/benchmark/stage-listening-review.html`。后者包含待生成器替换的 `const data=/* STAGE_DATA */;`，不是可直接执行的应用入口，导致依赖扫描失败。

真实用户目录中有一份不符合当前契约的历史文档：指针含旧 `schemaVersion` 字段，正文使用 `source.raw/runs/supported` 等旧结构。原指针没有摘要，不能把“没有 digest”说成摘要被篡改。只读检查确认它无法按当前快照结构恢复。未删除、移动或改写真实用户目录。

将该文档目录复制到隔离 userData 后，用当前 `pnpm dev` 的 HTTP 页面启动真实 Electron。修复前 `listDocuments` 返回 `document_unavailable`，页面显示“文档读取或保存失败”，点击按钮时 `dialog.showOpenDialog` 调用次数为 0。对照空配置，列表正常，按钮调用次数为 1。

错误传播链：`DocumentRepository.listSnapshot()` 因一份无有效提交的文档整体失败；所有 IPC 在执行实际方法前等待 `TranslationService.initialize()`；initialize 永久缓存失败的 Promise。因此历史文档使新导入等无关操作也无法执行。之前的构建版、空配置验收没有覆盖这条开发环境历史数据路径。

## 修复行为

- Vite 显式使用 `optimizeDeps.entries: ['index.html']`，模板和报告继续由各自生成器使用。
- 文档列表逐份隔离 `document_unavailable`，返回可用文档以及 `unavailableDocuments` 数量。保留不可恢复文档的全部原始文件；直接读取仍明确报错，不提升孤立 generation、不编造空文档、不猜测迁移旧格式。
- 库目录整体读写失败仍报错，不能伪装为空库。初始化合并并发请求，但失败后释放缓存，让用户重试可重新访问存储。
- IPC 将不可恢复数量传给页面。沿用 `studio-notice`，四语言提示旧数据仍保留，可以使用其他文档或重新打开原字幕文件；恢复提示不会阻断导入。

沿用 R-WORKSPACE-03 的数据保留和明确恢复失败要求，以及 T06 的真实集成验证范围。依 `spec-driven-ai-coding` 小修复流程记录证据，不修改原 AC，不代签 I1 用户验收。UI 采用项目 UI 技能现有通知条、字号与间距，验证桌面浅色及 786×540 深色换行和按钮可达。

## 验证

- 字幕工作台模块：316 项通过、17 项显式选择执行的测试跳过（含开发模式测试）；记录 `test-results/studio-dev-suite.log`。随后新增“仓库整体不可用仍报错”反例并单独复验：仓库 23 项全部通过，见 `test-results/studio-dev-final-regression.log`。合计已验证 317 项模块测试，另有下述显式启用的开发版 Electron 测试。
- `tsc --noEmit` 与 `tsc --noEmit -p tsconfig.node.json` 通过；四语言 locale/source usage 检查通过（既有同文提示不属于失败）。
- 在 `VSCODE_DEBUG=1`、`DEBUG=vite:deps` 下执行 `pnpm dev --host 127.0.0.1 --port 7777 --strictPort --force`，强制重新扫描。日志只有应用 `index.html` 一个扫描入口，扫描和预构建成功；主进程及 preload 开发构建完成。证据：`test-results/studio-dev-final.log`。`VSCODE_DEBUG` 仅阻止插件额外启动 Electron，测试自行持有隔离实例；7777 使用本机调试配置端口。
- 显式启用 `FUSIONKIT_STUDIO_DEV_URL=http://127.0.0.1:7777/` 运行 `development-ui.test.ts`：1 项通过，26.98 秒。真实 Vite renderer、Electron preload、主进程、持久文件；仅控制 OS 选择/保存对话框的返回值，不声称测试了 Windows 原生对话框的人工键入。
- 用户步骤：进入含不可恢复历史文档的工作台 → 点击按钮取消 → 点击按钮导入中文名 SRT → 预览 → 关闭重启 → 预览 → 点击下载原文件，输出与源文件字节一致。原历史指针和 generation 保持不变；无页面异常或阻断 alert。
- 对实际历史文档副本再次运行：列表成功并报告不可恢复数量 1，按钮调用到 `showOpenDialog`，无阻断 alert。证据：`test-results/studio-dev-existing-after.log`。该文档仍需重新打开原字幕文件；本次没有伪造其迁移或恢复结果。
- 亲自审阅 `test-results/subtitle-studio-development/import-desktop.png` 与 `restored-narrow-dark.png`：全局 loading 已退出，通知可读，导入/文件选择及下载入口可达，正文和恢复提示共存，无横向溢出。

本次不声称完成发布包验证或重新执行全部旧工具真实 ASR。开发环境复现覆盖已补齐，I1 用户最终确认仍由用户完成。

## 收尾

验证进程由本轮持有，结束前已关闭并核对进程表为空。原始用户文档的 2 个文件与修复前副本 SHA-256 一致；3 个已核对路径的临时复现配置已清理，结果见 `test-results/studio-dev-cleanup.json`。先前未跟踪的 Windows 端口避坑文件保持原样。随后用户明确要求提交并推送，本轮修复随 `fix(subtitle-studio): unblock development startup and document import` 提交集成；不发布、不进入 I2。
