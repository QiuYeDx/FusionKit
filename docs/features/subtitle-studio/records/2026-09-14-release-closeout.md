# 实施记录：T-RELEASE-04 真实流程与最终集成

| 字段 | 值 |
| --- | --- |
| 任务 | T-RELEASE-04 |
| 日期 | 2026-09-14 |
| 验证版本 | dec9010 + 2026-09-14-release.snapshot.json（SHA-256 38bd3dfec11f3b2bdd5bb3827cc4ea6461b12c6c7a80a691bb1edb0776d01849）；原生实物/实际app另以各自回执及报告绑定 |
| 环境 | macOS 26.2 arm64、Node 20.19.5、Electron 41.10.6、Vitest 2.1.9、Playwright 1.58.2；使用已有 pnpm 8.7.0 依赖，未安装或修改锁文件 |
| 任务指纹 | 160db418d8d100fd2b3130f59c9b1e03bab317167b6b99085231d7e85eaf022f |

## 实际结果

本轮按用户指定完成原盘点 1、2、4 的本机工作，I4 编辑没有推进。新增独立 macOS 原生资源和构建工具，修复首次资源导入、隐藏重载启动遮罩及 ad-hoc 签名运行问题；开发构建和最终签名 app 均完成真实工作流。

最终测试位于 `test/subtitle-studio-provenance/release-real-workflow.test.ts`。使用独立 profile，复制已有供应商配置及模型；原始 profile、模型和媒体不变，测试结束删除全部凭据及模型副本。配置来源切换全部在 Electron main 内完成，runner 只收到布尔值。测试根据实际 `app.isPackaged` 与 executable/asar hash 识别成品，三次启动身份一致。

### 真实业务链路

- 上游 JFK 语音、large-v3-q5_0 固定模型，先通过生产资源导入。没有替换 ASR runtime、supervisor、IPC 或文档仓库。
- 在真实 UI 选择 CPU、Metal，分别执行转写；两份文档各得到 3 条英文字幕。Metal 使用实际设备证明，未用 CPU fallback 充数。
- 关闭 app 后从生产文档仓库重读内容，再重新启动核对文档 ID 和列表。持久化对象是文档；转写任务队列仍只属于当前会话。
- 通过公开 Studio 翻译 IPC 调用已有配置的真实供应商，两份文档均完成中文译轨。本项验证实际服务链路；没有把它描述为点击翻译按钮的 UI 验收。翻译按钮与结果交互由另行完成的 I7 受控服务套件覆盖。
- 通过 UI 导出一份双语 SRT，然后切到 786×540 深色文档库执行批量导出。分别新增 1、2 个文件；第二轮对已存在的 CPU 文件生成 `(1)` 副本，旧文件 hash 不变。逐个读取全部 3 个文件，校验英文、中文、SRT 时间格式和内容 hash。
- 最终源音频与源模型 hash 均未变，pageErrors 为空；3 次 app 启动和所有追踪到的子进程退出，隔离 profile/app 清理成功。

开发构建最终运行 `test-results/studio-release-real/run-YEYFrf/`，35.73 秒通过。签名 app 最终运行 `test-results/studio-release-real/run-oUQrQE/`，44.91 秒通过；该运行额外包含源模型最终 hash 核对，机器可读结果见 [真实应用报告](2026-09-14-release-workflow.json)。

### 渲染审阅与测试修正

实际查看最终 app 的 1280×860 浅色转写完成队列、文档双语预览、单份导出，以及 786×540 深色批量成功弹窗：两设备均显示完成；文档原译文和时间轴可读；窄窗口结果标题、文件数与完成按钮均在可见范围内，无全局加载遮罩残留。

测试初版在主进程完成后立即截图，UI 仍可能显示旧进度；现等待对应队列行实际进入 completed。窄窗口文档库需要通过现有入口打开后才能操作批量下载，已按真实交互补齐。Playwright dispatcher 在 close 后已销毁，不能重新调用 app.process()；测试提前保留 ChildProcess 句柄并核对 OS 退出，避免把清理脚本异常算作产品失败。以上修正未改变产品行为或放宽验收断言。

### 本轮检查范围

最终共享资源与来源套件 23 文件 / 227 项通过，5 项显式 opt-in 未运行；真实 macOS 业务用例已单独执行。接线、导出、source-output、runtime 与 task-service 5 文件 / 113 项通过、2 项既有跳过。独立原生工具 35 项、packaging/signing 23 项通过。两套真实启动/结果 UI 回归见 [启动记录](2026-09-14-release-loading.md)。这些结果对应本轮受影响范围，不冒充全平台或全量测试。

旧来源生成器 `--check-worktree` 的 Node/Git stdin 在本机再次挂起，已终止自有检查进程。采用已有且具备逐子进程超时的 copy checker 完整检查源工作树、精确集成审计和 120 个冻结副本；另行 `generate --check` 重建核对 279 文件 / 1605 依赖的历史基线。没有更改冻结生成器或忽略来源差异。此次还补上已拉取的 revealSource、导出策略和版本更新所遗漏的当前审计。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RELEASE-04-1 | 通过 | file:records/2026-09-14-release-workflow.json |
| V-RELEASE-04-2 | 通过 | file:records/2026-09-14-release-validation.json |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RELEASE-01-2 | 通过 | V-RELEASE-04-1 |
| AC-RELEASE-03-3 | 通过 | V-RELEASE-04-2 |

最终生产/工作流严格 TypeScript、三端构建、preload bundle、四语 i18n、446 文件边界、当前集成审计及 diff 检查均通过。i18n 保留 21 项既有同值提醒，无缺失或失效 key。全部本轮服务与探针已关闭，DMG 挂载及隔离副本已清理。项目避坑规则据此次真实失败补入 FK-PIT-0153/0154/0155。

## 风险与未执行项

正式 Developer ID、公证、Windows 最终发行包及安装/更新/卸载全生命周期仍需要凭据和对应目标机。本轮仅在 macOS 上使用约 11 秒 JFK 样本，VAD 关闭；不是全面媒体质量或默认 VAD 验收。现有历史 Windows/VAD 矩阵保留各自版本边界。I4 继续暂停，所有批次的用户整体验收保持独立 pending；本轮未公开发布、提交或推送。

本机候选产物在 `release/0.3.1/`，清单见 [产物与摘要](2026-09-14-release-artifacts.json)，正式发行条件见 [签名与许可说明](2026-09-14-release-signing-readiness.md)。
