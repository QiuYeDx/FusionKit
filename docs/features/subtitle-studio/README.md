# 字幕工作台：独立新版工具

工作名称：字幕工作台 / Subtitle Studio。工具身份 `subtitleStudio`，路由 `/tools/subtitle/studio`。独立文档、翻译和导出与现有 v1 工具共存。

## 当前进度（2026-09-12）

I1 的 T-WORKSPACE-01 至 T-WORKSPACE-08 功能均已完成。涵盖 SRT/LRC 文档、权限与持久化、文本翻译、双语整理、恢复/取消、多模式导出，以及文档库搜索/分页/跨页选择、批量翻译/导出/管理。用户整体验收仍由 spec.json 单独记录为 pending。

已集成版本：`a742746` 文档库批量工作流、`2878b94` 范围预览、`d5e98d4` 配置折叠与批量确认、`3a0f50e` 计划概览与列表渐变。2026-09-11 进度盘点已核对本地和远端均为 `3a0f50e`；当时工作树干净。历史实施记录中的“未提交”是验证当时的状态，不代表这些改动现在未集成。

本次盘点发现新增通用 UI 依赖未同步边界清单，独立 CLI 报三处未审计引用，而原来的边界测试只覆盖合成负例。现已补准确包项和真实仓库回归；本次收尾与最终验证见 [I1 门禁收尾](records/2026-09-11-boundary-closeout.md)。

用户随后多次回复“好的，继续往后推进工作吧”，继续指令承接先 I1 收尾、再 I2 的建议。当前已完成 **I2 来源冻结、独立副本/确定性回放、独立runtime及本机原生验证、最终转录文档生产者**，来源以 `3a0f50ed15c1b63451402cecf27240182235e567` 为准。120文件转写副本之外新增16份native/构建副本、4份runtime校验副本；新工厂拥有私有资源、owner权限及可重试关闭，macOS addon真实编译/ad-hoc签名/Electron事务恢复通过。T04另建派生executor与内部producer/sink，清理后直接提交完整转录的schema2媒体文档，兼容现有分页/翻译/SRT与LRC导出。任务准入、应用接线和转写UI仍待下一阶段。当前I2改动仍在未提交共享工作树，I1/I2用户整体验收独立保持pending。

来源闭包审查见[I2基线冻结记录](records/2026-09-11-transcription-baseline.md)；复制规则、新旧回放、真实品牌隔离见[I2独立副本记录](records/2026-09-11-transcription-copy-replay.md)；私有runtime、双资源预检及实际原生证据见[I2运行时与原生验证](records/2026-09-12-transcription-runtime-native.md)；完整证据映射、容量及提交边界见[I2转录文档生产者](records/2026-09-12-transcription-document.md)。最新1094项普通回归、49项来源/回放、1项实际Electron场景及两套TS/i18n/298文件实际边界通过；T03原生/packaging历史证据和环境专属跳过项分别记录，未冒充本轮重跑。

## 阅读顺序与权威位置

| 文档 | 负责内容 |
| --- | --- |
| [批次与授权](spec.json) | 当前增量、真实授权、待定决策与独立整体验收 |
| [业务范围](brd.md) | 用户约束、产品边界、分期目标 |
| [整体架构](architecture.md) | 独立边界、字幕模型、持久化、翻译与格式契约 |
| [转写继承与 v1 删除验证](transcription-fork.md) | 生产基线、效果保护、资源与打包归属、移除演练 |
| [I2 需求](modules/module-transcription/requirements.md) | 当前转写继承阶段的唯一需求与 AC |
| [I2 设计](modules/module-transcription/design.md) | 当前阶段方案、工具与审查边界 |
| [I2 任务](modules/module-transcription/tasks.md) | 当前阶段任务状态、依赖、验证与下一步 |
| [I1 需求](modules/module-workspace/requirements.md) / [设计](modules/module-workspace/design.md) / [任务](modules/module-workspace/tasks.md) | 已有文档工作流的行为契约及历史任务状态 |

任务状态只维护在所属 tasks.md；批准和批次只维护在 spec.json。实现后的字段级事实以类型和校验器为准。旧 `docs/v0.2.11` 总迭代台账保留历史背景，部分“未开始”与旧检查失败说明已经过时，不作为当前工作台任务源。

## 下一步

下一项细化新版转写任务准入/队列与应用runtime、main/preload接线，再接转写UI。T04生产者目前消费已准入的内部上下文；Q-02已解决：文档保持100000 cues/128MiB上限、超限整体拒绝，完整保留已有转录证据，不经SRT往返。完整新版FFmpeg/Whisper构建输入和回执仍待准备，现有双资源beforePack会在旧贡献通过后正确拒绝缺失的新版staging。

Windows原生实跑、完整ASR/真实音频GPU、有界新旧效果对照、共存/删除后的完整应用包、外层签名/公证仍待后续验证。后续不得以清单hash、合成模型或本机ad-hoc addon验证代替这些证据。

保留旧版已经接受的转写质量局限；I3 ASS、I4 编辑继续后置。全产品安装更新卸载、分发许可、音频真实设备/供应商验收独立安排，不从旧研究台账重启无限调参。

## I1 证据索引

- [最小文档链路](records/2026-09-08-i1-implementation.md)、[持久化权限](records/2026-09-08-workspace-02.md)、[文本翻译及真实 API](records/2026-09-09-workspace-03.md)。
- [双语整理](records/2026-09-09-workspace-07.md)、[混合双语修复](records/2026-09-09-workspace-07-mixed.md)、[预览与分页](records/2026-09-10-workspace-07-preview.md)。
- [恢复与取消](records/2026-09-10-workspace-04.md)、[多模式导出](records/2026-09-10-workspace-05.md)、[macOS 集成验证](records/2026-09-10-workspace-06.md)、[Windows I1 收尾](records/2026-09-10-i1-closeout.md)。
- [既有检查修复](records/2026-09-10-check-failures.md)、[开发启动与历史坏文档隔离](records/2026-09-11-development-startup-fix.md)、[文档库/批量及后续 UI 打磨](records/2026-09-11-library-batch.md)。

历史的2069项相关回归、333项模块测试和各轮Electron场景各有验证版本与环境，不表示最新源码每轮重跑全部测试；也不代表已打发布安装包。布局、视觉和最终截图细节留在对应记录。

## 换机器接续

先保护未提交改动，再拉取 `v0.3.1`。源码、当前规格和项目级避坑技能随 Git 同步；用户级技能、模型设置、凭据、node_modules、test-results、模型及本机原生资源不随 Git 同步。使用兼容旧 lockfile 的 pnpm；只需检查时优先直接调用已安装工具的 Node 入口，不触发包装器自动安装。

Windows/macOS 历史绝对路径只作为当时环境证据。新平台按当前任务执行适用检查，缺环境如实登记；原生资源身份不等于本机实测通过。没有用户级规格 checker 时可按本仓库明确的 R/AC/T/V 人工核验并记录工具缺失，不制造业务阻塞。

可在新任务中发送：

```text
请继续 FusionKit 的独立字幕工作台开发。
先读 docs/features/subtitle-studio/README.md、spec.json 和当前批次的 requirements/design/tasks，
核对当前 Git 提交、工作树、任务依赖及最新实施记录，从首个就绪未完成任务继续。
沿用当前已登记的实施授权与范围，保留旧 v1；不代签整体验收、不自动发布或删除真实数据。
使用已安装且与 lockfile 兼容的工具，结束前关闭本次启动的前端服务。
```
