# 字幕工作台：独立新版工具

工作名称：字幕工作台 / Subtitle Studio。工具身份 `subtitleStudio`，路由 `/tools/subtitle/studio`。独立文档、翻译和导出与现有 v1 工具共存。

## 当前进度（2026-09-12）

I1 的 T-WORKSPACE-01 至 T-WORKSPACE-08 功能均已完成。涵盖 SRT/LRC 文档、权限与持久化、文本翻译、双语整理、恢复/取消、多模式导出，以及文档库搜索/分页/跨页选择、批量翻译/导出/管理。用户整体验收仍由 spec.json 单独记录为 pending。

已集成版本：`a742746` 文档库批量工作流、`2878b94` 范围预览、`d5e98d4` 配置折叠与批量确认、`3a0f50e` 计划概览与列表渐变。2026-09-11 进度盘点已核对本地和远端均为 `3a0f50e`；当时工作树干净。历史实施记录中的“未提交”是验证当时的状态，不代表这些改动现在未集成。

本次盘点发现新增通用 UI 依赖未同步边界清单，独立 CLI 报三处未审计引用，而原来的边界测试只覆盖合成负例。现已补准确包项和真实仓库回归；本次收尾与最终验证见 [I1 门禁收尾](records/2026-09-11-boundary-closeout.md)。

I2 的 T01–T04 已随今天的 `e80ef6b` 集成到 `feat/subtitle-studio-transcription`。当前继续指令下，**T05任务准入/接线和T06转写工作区均已完成**：媒体多选/音轨与探测重试、独立资源准备、参数设置、FIFO队列进度/取消和完成文档入口已经接通。草稿与观察状态保留至本renderer会话的SPA切换，发布后的文档继续持久化。T05–T08已提交并推送99d0647，I1/I2用户整体验收仍pending；各实施记录中的未提交状态保留为验证当时事实。

T01来源冻结、T02独立副本和T03原生证据分别见对应历史记录；T04见[I2转录文档生产者](records/2026-09-12-transcription-document.md)。[T05任务准入与应用接线](records/2026-09-12-transcription-admission.md)保留当时1137项普通回归、75项来源/配对回放、1项实际Windows Electron桥接和两套TS/i18n/306文件边界证据。合成推理及桥接验证不代表真实ASR或GPU通过。

T06证据见[转写工作区](records/2026-09-12-transcription-ui.md)：1161项相关普通回归、75项来源/回放，2项新转写实际Electron场景及2项既有工作台/媒体导出Electron回归通过；两套TS/i18n、316文件边界和真实preload构建通过。已审阅1280×860浅色、786×540深色、长名称/键盘/高级参数/资源弹窗。该轮完整流程仅以受控runtime验证UI/main/仓库交接；另用真实生产runtime证明资源缺失时正确阻止执行。

**T07 Windows独立资源与真实CPU对照已完成**，见[当前实施记录](records/2026-09-12-transcription-windows-runtime.md)。新版15个FFmpeg/Whisper制品和原生addon已在本机独立staging，实际双资源beforePack预检通过；Windows Electron原生83案例通过。真实30秒音频、large-v3-q5_0、CPU/VAD关闭/fixed_v1下，新旧均输出6条字幕且文本/时间完全一致，新文档关闭后重开成功。源音频/模型及旧staging未变，测试进程已退出。I1/I2用户整体验收仍pending。

**T08默认VAD与CPU/CUDA固定样本对照已完成**，见[默认配置与设备实测](records/2026-09-12-transcription-default-devices.md)。六样本两设备新旧24次加CUDA A固定重复2次，共26次真实运行；22次成功、4次无识别真实失败，13组配对终态一致，11组完整canonical无差异，11份新文档关闭后重开通过。实际模型/VAD/CUDA安装、精确PID设备证明及卸载完成，相关278项普通检查、类型/边界/规格通过。full接缝重复及C字幕过长等共同局限保留，不代签整体质量接受；CPU/CUDA本身也有分句差异。测试原生进程及独占资源根已清理，本轮实测未改生产源码与原有资源。

**T09共享资源与已有安装接管已完成**，见[共享资源实施记录](records/2026-09-12-transcription-shared-resources.md)。模型、VAD、兼容CUDA由应用级唯一服务维护，两工具共用文件和安装状态，下载/取消/删除跨页同步，任务占用阻止资源删除。实际已有4项资源、23个payload共约5.38GB已无下载迁入共享目录，文件内容与对象身份保持，两个入口均ready。共享资源CPU/CUDA四条真实链路、新旧同设备完整结果一致、两份文档重开及退出清理通过；实际Electron交互、232项最终共享回归、121项来源回归及377文件边界通过。T09已提交并推送15340fd，用户整体验收仍pending。

**I3六项人工验收完善已完成**：字幕拖入、转写队列批量维护、全库翻译总览与本轮进度、VTT/ASS完整工作流、字幕/媒体来源目录导出、默认无后缀及可选命名均已接通。最终3项实际Electron综合场景、两套生产与测试严格TS、i18n/边界/相关来源回归通过，小窗口遮挡和Windows默认保存路径大小写保护已修复。见[原始问题](records/2026-09-12-manual-acceptance-findings.md)、[综合收尾记录](records/2026-09-12-acceptance-closeout.md)、[需求](modules/module-acceptance/requirements.md)、[设计](modules/module-acceptance/design.md)、[任务](modules/module-acceptance/tasks.md)。本轮工作树未提交；用户整体验收仍pending。

## 阅读顺序与权威位置

| 文档 | 负责内容 |
| --- | --- |
| [批次与授权](spec.json) | 当前增量、真实授权、待定决策与独立整体验收 |
| [业务范围](brd.md) | 用户约束、产品边界、分期目标 |
| [整体架构](architecture.md) | 独立边界、字幕模型、持久化、翻译与格式契约 |
| [转写继承与 v1 删除验证](transcription-fork.md) | 生产基线、效果保护、资源与打包归属、移除演练 |
| [I3 需求](modules/module-acceptance/requirements.md) / [设计](modules/module-acceptance/design.md) / [任务](modules/module-acceptance/tasks.md) | 本轮六项人工问题及其完成证据 |
| [I2 需求](modules/module-transcription/requirements.md) | 当前转写继承阶段的唯一需求与 AC |
| [I2 设计](modules/module-transcription/design.md) | 当前阶段方案、工具与审查边界 |
| [I2 任务](modules/module-transcription/tasks.md) | 当前阶段任务状态、依赖、验证与下一步 |
| [I1 需求](modules/module-workspace/requirements.md) / [设计](modules/module-workspace/design.md) / [任务](modules/module-workspace/tasks.md) | 已有文档工作流的行为契约及历史任务状态 |

任务状态只维护在所属 tasks.md；批准和批次只维护在 spec.json。实现后的字段级事实以类型和校验器为准。旧 `docs/v0.2.11` 总迭代台账保留历史背景，部分“未开始”与旧检查失败说明已经过时，不作为当前工作台任务源。

## 下一步

用户明确暂停打包演练，T09共享资源范围已完成，当前无需要继续实施的共享资源子项。两个入口共用同一兼容资源，未来从任一资源页安装或删除会同步影响另一工具。原生staging保持既有闭包；任务状态只在本会话保留，新文档继续持久化，容量保持100000 cues/128MiB、超限整体拒绝。

T07短样本与T08固定Windows矩阵不替代所有媒体质量、macOS完整资源、共存/移除后的完整应用包或签名/公证验证；这些仍待后续任务。build实物被Git忽略，换机需按固定来源重新制作，不能只凭清单hash宣称就绪。

保留旧版已经接受的转写质量局限；I3六项已完成，下一步为用户复验；I4编辑继续后置。全产品安装更新卸载、分发许可、音频真实设备/供应商验收独立安排，不从旧研究台账重启无限调参。

## I1 证据索引

- [最小文档链路](records/2026-09-08-i1-implementation.md)、[持久化权限](records/2026-09-08-workspace-02.md)、[文本翻译及真实 API](records/2026-09-09-workspace-03.md)。
- [双语整理](records/2026-09-09-workspace-07.md)、[混合双语修复](records/2026-09-09-workspace-07-mixed.md)、[预览与分页](records/2026-09-10-workspace-07-preview.md)。
- [恢复与取消](records/2026-09-10-workspace-04.md)、[多模式导出](records/2026-09-10-workspace-05.md)、[macOS 集成验证](records/2026-09-10-workspace-06.md)、[Windows I1 收尾](records/2026-09-10-i1-closeout.md)。
- [既有检查修复](records/2026-09-10-check-failures.md)、[开发启动与历史坏文档隔离](records/2026-09-11-development-startup-fix.md)、[文档库/批量及后续 UI 打磨](records/2026-09-11-library-batch.md)。

历史的2069项相关回归、333项模块测试和各轮Electron场景各有验证版本与环境，不表示最新源码每轮重跑全部测试；也不代表已打发布安装包。布局、视觉和最终截图细节留在对应记录。

## 换机器接续

先保护未提交改动，再拉取 `feat/subtitle-studio-transcription`（T01–T04已在e80ef6b；T05–T08由本次提交接续）。源码、当前规格和项目级避坑技能随 Git 同步；用户级技能、模型设置、凭据、node_modules、test-results、模型及本机原生资源不随 Git 同步。使用兼容旧 lockfile 的 pnpm；只需检查时优先直接调用已安装工具的 Node 入口，不触发包装器自动安装。

Windows/macOS 历史绝对路径只作为当时环境证据。新平台按当前任务执行适用检查，缺环境如实登记；原生资源身份不等于本机实测通过。没有用户级规格 checker 时可按本仓库明确的 R/AC/T/V 人工核验并记录工具缺失，不制造业务阻塞。

可在新任务中发送：

```text
请继续 FusionKit 的独立字幕工作台开发。
先读 docs/features/subtitle-studio/README.md、spec.json 和当前批次的 requirements/design/tasks，
核对当前 Git 提交、工作树、任务依赖及最新实施记录，从首个就绪未完成任务继续。
沿用当前已登记的实施授权与范围，保留旧 v1；不代签整体验收、不自动发布或删除真实数据。
使用已安装且与 lockfile 兼容的工具，结束前关闭本次启动的前端服务。
```
