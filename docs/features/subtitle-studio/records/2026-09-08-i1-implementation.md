# I1 实施记录

日期：2026-09-08。任务：T-WORKSPACE-01。负责人：Codex。

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-01 |
| 日期 | 2026-09-08 |
| 验证版本 | 4791e10cd8443a0aecbfe7ad5bd05ad2b57555b2 加未提交源码快照 3ec1f0f301f49c241229314199a40abb46cf8e3ac51621dc2242eef6cf016807；用户手动验证补充 |
| 环境 | macOS，Node 20.19.5，pnpm 8.7.0，Electron 41.10.6；用户当前本机运行实例 |
| 任务指纹 | 155d1d424270b44d9264529f5537197c89a89290ec873c7570f6eb731ea1926d |

## 授权与基线

真实授权来自当前 Codex 任务用户 2026-09-08 的实施消息，原文登记于 spec.json；范围为已定义 I1，不包含 I2、实际移除工作树 v1 或发布。实施前已读 README、spec、BRD、架构、转写继承边界及 I1 requirements/design/tasks。

基线：v0.3.1，4791e10cd8443a0aecbfe7ad5bd05ad2b57555b2，开始时工作树干净。本机 Node v20.19.5，lockfileVersion 6.0，存在 node_modules。优先运行本地工具；不更新 lockfile。

## 验证记录

- ready checker（2.0.0）通过，errors/warnings 均为空；scope_digest 为 26bde5f69e3431a2ff3329f8b0cbdf006aba57e7e2f29ced6ef37d87d0206013。该结果仅证明规格结构，不代表业务验证通过。
- T-WORKSPACE-01 指纹：155d1d424270b44d9264529f5537197c89a89290ec873c7570f6eb731ea1926d。

## 实际结果

已登记授权并实现首项任务的最小链路。用户补充原生导入与保存证据后，T-WORKSPACE-01 完成。I1 未完成，未签署整体用户验收，未启动原生转写移植。

## 当前实现与版本

实际验证版本：4791e10cd8443a0aecbfe7ad5bd05ad2b57555b2 加当前未提交工作树。将 `git ls-files --modified --others --exclude-standard` 列出的非 docs 文件排序，对每个路径、NUL、文件字节、NUL 计算 SHA-256：29 个文件，`3ec1f0f301f49c241229314199a40abb46cf8e3ac51621dc2242eef6cf016807`。本记录后续文档变更不参与此摘要。

环境：macOS，Node v20.19.5，pnpm 8.7.0，Vitest 2.1.9，Vite 5.4.21，Electron 41.10.6，Playwright 1.58.2。本机依赖已存在；未安装/升级依赖。pnpm-lock.yaml 与 HEAD 字节相同。

新增 `/tools/subtitle/studio`、`window.subtitleStudio`、`subtitle-studio:*`、独立版本化文档与偏好。原生选择 SRT/LRC、严格解码、安全 span、稳定 cue/node ID、原文持久化、分页预览和原格式原文导出已实现。原始编号、BOM/CRLF、LRC offset/多标签不被翻译投影消耗；目前没有 AI 请求、译文轨操作或多模式导出 UI。

应用组合增量清单：src/App.tsx、src/constants/router.ts、src/pages/Tools/index.tsx、src/pages/Tools/_shared/toolMeta.ts、electron/main/index.ts、electron/preload/index.ts、electron/electron-env.d.ts、src/i18n/resources.ts。旧专属实现未修改。静态检查根/禁止路径/第三方模块与组合清单在 scripts/subtitle-studio/boundaries.json；不以该检查代替 I1 最终实际移除演练。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-01-1 | 通过 | inline: vitest 的 formats.test.ts 共 17 项通过，包含 SRT 多行/不连续编号/重叠/BOM/CRLF/简单嵌套标签、LRC 元数据/多标签/同时间不同文本/offset、重排稳定 ID 和源节点覆盖；源字节导出一致 |
| V-WORKSPACE-01-2 | 通过 | inline: 同套测试覆盖四编码、非法字节/截断编码、倒序时间、未知标签/增强型 LRC 诊断、文件/cue/展开数/节点上限、无效映射/schema；失败解析未增加仓库文档 |
| V-WORKSPACE-01-3 | 通过 | inline: 实际 Electron 受控对话框测试通过两格式导入、源内容不变、移走源文件、关闭重启、持久预览和逐字节源导出；原生 SRT 选择已有观察，用户于 2026-09-08 补充手动导入几百 KB LRC 显示正常及原生保存导出正常，两条原文见下方记录。自动化原生对话框超时历史保留 |
| V-WORKSPACE-01-4 | 通过 | inline: node scripts/subtitle-studio/check-boundaries.mjs 检查 31 个文件 0 errors；boundaries.test.ts 两项通过，反例涵盖直接 import/export、type/import-type、动态 import、barrel、旧测试 helper、资源字符串 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-02-1 | 通过 | V-WORKSPACE-01-1, V-WORKSPACE-01-3, V-WORKSPACE-01-4 |
| AC-WORKSPACE-02-2 | 通过 | V-WORKSPACE-01-2, V-WORKSPACE-01-3, V-WORKSPACE-01-4 |

实际命令与结果：

- `node_modules/.bin/vitest run test/subtitle-studio/formats.test.ts test/subtitle-studio/boundaries.test.ts`：最终 19/19，通过，2026-09-08 14:48。
- `FUSIONKIT_STUDIO_E2E=1 node_modules/.bin/vitest run test/subtitle-studio/electron.test.ts`：最终 1/1，通过，14:49，耗时 9.74s；实际生产构建/main/preload/renderer，文件对话框返回值受控。隔离 userData，原文件移走后重启再导出一致，脚本正文只展示文本，window.studioInjected 未定义，pageerror 为空。
- `FUSIONKIT_STUDIO_E2E=1 FUSIONKIT_STUDIO_NATIVE_DIALOGS=1 node_modules/.bin/vitest run test/subtitle-studio/electron.test.ts`：原生对话框模式未完成，14:42 启动的一次在 300s 超时；此前一次路径 UI 操作不稳定后中止。原生 SRT 导入成功不是全流程通过。临时路径输入未涉及用户文件导入。
- 第一次沙箱内 Electron 启动 SIGABRT；通过宿主权限机制在隔离 userData 运行后受控链路通过。该失败属于启动环境记录，不替换为测试成功。
- `node_modules/.bin/tsc --noEmit`：基线和当前均通过。
- `node_modules/.bin/vite build --mode=test`：renderer/main/preload 均通过；保留原有 chunk 大小和 useModelStore 混合导入警告。
- `node scripts/check-preload-bundle.mjs`：通过，仅 electron 外部依赖。
- `node scripts/check-i18n.mjs`：四语言 studio 各 34 key，完整性通过，另有 17 项既有同文警告。
- `node scripts/check-i18n-usage.mjs`：失败于旧 NameTranslator OptionsPanel 的 DYNAMIC_KEY 和 STALE_MANIFEST，两处涉及源码、manifest 及 checker 已与 HEAD 逐字节比对，均未修改；没有新版 studio key 错误。本次不扩大写集修旧重命名页面。
- `git diff --check`：通过。

## UI 证据索引

实际查看截图：仓库 `test-results/subtitle-studio/srt-desktop.png`、`lrc-desktop.png`、`narrow.png`（本机生成物，不保证随 Git 同步）。窗口 1080×786 / 786×540，Retina 2x。截图前等待 `.app-loading-wrap` 与 `#app-loading-style` 消失。桌面原文/时间/诊断可读；窄窗口选中文档置于列表之前，没有横向溢出。长文本/100 页/四语言交互等完整矩阵留在 T-WORKSPACE-06，不能将这组最小截图当作完整 UI 验收。

## 风险与未执行项

### 2026-09-08 用户手动验证补充

来源：当前 Codex 任务用户消息，原文：“我自己手动验证了一下，导入了一个几百kb大小的lrc字幕文件没有问题 显示都正常”。验证人：用户。结果：实际 LRC 导入和显示正常，样本量级为几百 KB。未提供精确字节数、cue 数、文件 hash 或运行构建指纹，因此不据此声明性能上限、所有分页或完整格式矩阵通过；本次未读取或上传该用户文件。

首条反馈补充 V-WORKSPACE-01-3 的实际 LRC 导入/预览证据，保留此前自动化超时历史。随后用户在同一任务明确报告：“原生保存导出我也试过了没问题”。验证人仍为用户，补齐原生保存导出的实际操作结果。未将用户报告扩写为其进行过 hash、故障注入或重启测试；这些内容的一致性与重启证据来自此前受控 Electron 测试。两类证据结合完成首项最小链路验证，不代表 I1 整体验收。

T-WORKSPACE-01 已完成。收尾时复核源码快照仍为 3ec1f0f301f49c241229314199a40abb46cf8e3ac51621dc2242eef6cf016807，原有自动化证据仍适用。随后用户明确要求“先不要继续后续的开发工作”，当前执行暂停；T-WORKSPACE-02 及后续未领取，等待用户恢复指令。本次只修改文档，未启动前端或 Electron 服务。

下一步为 T-WORKSPACE-02：补齐 generation 失败恢复/当前指针损坏/墓碑/完整 owner 与修订负例，当前 create-only 仓库尚不具备这些能力。真实 API、翻译取消恢复、多模式导出、v1 回归/移除演练、Windows 替换失败及整体验收都未执行。

使用项目 pitfall 技能后，验证采用真实 Electron、等待 loading 退出、检查源用法 i18n、固定 preload 方法并调整窄窗口顺序。所有本轮启动的测试 Electron 在测试结束或中断时关闭；UI 选择工具额外启动的 Electron 默认窗口已定位 PID 13946 并发送 TERM。最终使用 ps 核对仓库 Electron、studio-electron、Vite 和 vitest 模式，输出为空；未启动常驻 Vite 服务。最终 ready --require-approval 为 0 error / 0 warning，git diff --check 通过。
