# 工作包 DOC-001：预发布文档基线

## 基本信息

- 日期：2026-08-06
- 状态：进行中
- 对应执行计划工作包：`DOC-001`
- 目标平台/硬件：文档工作包；不执行目标硬件、Electron 或 packaged QA

## 本次认领边界

- 只完成不依赖 QA 结论的发布文档基线：README、CHANGELOG、隐私、资源/磁盘、恢复、卸载保留、第三方许可入口和两级进度台账。
- 不生成或修改下载产物，不启动 Vite/Electron/native runtime，不执行真实模型、VAD、CUDA、Metal、installer、签名/公证或外部 API 验收。
- 不把开发侧 component/packaged consumption 证据扩大为 stable 平台支持、最低硬件或性能承诺。

## 本次实现内容

- 新增 `local-subtitle-transcriber_release_notes.md` 预发布说明：
  - 列明当前功能与明确非目标。
  - 区分 Windows x64 CPU/CUDA、macOS arm64 Metal/CPU 的候选路径与尚未完成的发布证据。
  - 从固定 manifest 回填模型、VAD、CUDA archive/installed payload 的精确体积和瞬时磁盘边界。
  - 明确 FFmpeg/ffprobe 随应用提供，用户无需安装系统 FFmpeg，产品不接受任意 executable/path/backend flag。
  - 记录默认离线、显式外部翻译费用、本地持久化例外、恢复/取消、更新/卸载保留和空间回收语义。
  - 链接既有 runtime notices、license/source records 与资源 manifests，并明确 CUDA 许可仍为 `pending` / `artifactSharingAllowed: false`。
- README 增加本地字幕转写预发布亮点和功能章节，链接详细预发布说明。
- CHANGELOG 增加功能、安全与隐私、测试与文档、限制四类条目。
- 将主题 Final Design/Execution Plan、v0.2.11 文档入口和版本级执行台账同步到当前33个完成、5个未开始、1个进行中；`DOC-001`保持进行中。

## 修改文件

- `README.md`
- `CHANGELOG.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_release_notes.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- 本实施记录

## 接口、状态或数据结构变化

- 无代码、IPC、schema、Store、runtime manifest 或安装包配置变化。
- 工作包状态从`未开始`更新为`进行中`；顶层计数从31完成/6未开始/2进行中更新为31完成/5未开始/3进行中。

## 安全、隐私与许可证检查

- 文档没有记录本地绝对路径、真实样本内容、凭据、API Key、token 或 private header。
- 未复制任意产品下载 URL；资源来源只通过仓库内固定 manifest/source record 引用。
- 明确普通本地推理不上传媒体/字幕，自动翻译才会调用用户配置的第三方 API。
- 明确 v2 translation checkpoint 可能保存恢复所需字幕分片，以及成功、失败/取消、删除任务时的保留/清理边界。
- 明确 CUDA 候选包仍禁止对外分享，未把未关闭的 NVIDIA 许可写成完成。
- 按 `FK-PIT-0023` 明确 bundled FFmpeg/no-PATH 约束，未将系统 FFmpeg 或 executable picker写成用户前置。

## 验证结果

执行命令：

```text
PowerShell changed-Markdown local-link check
<Codex bundled Node> scripts/local-subtitle/benchmark/validate-manifests.mjs
git -c safe.directory=<workspace> diff --check
git -c safe.directory=<workspace> status --short
```

结果：

- 最终检查覆盖8个已跟踪变更或新增Markdown文件，本地链接全部存在。
- Manifest validation passed：0 errors / 0 warnings。
- `git diff --check`通过；Git仅提示工作区LF将在未来写入时按仓库设置转为CRLF，不是内容错误。
- 实际Node来自Codex workspace dependency runtime；记录中有意省略host-specific绝对路径。
- 未启动Vite、Electron、runner、FFmpeg、下载任务或其他常驻服务。

## 产生的证据

- 预发布说明中的资源体积来自仓库内固定模型/VAD/CUDA manifests。
- 平台、打包、隐私、恢复和卸载声明分别交叉核对Final Design、Execution Plan、`electron-builder.json`与既有第三方notice/source records。

## 未完成事项与风险

- `DOC-001`依赖`QA-005`的最终结果，当前不能标记完成。
- 最终平台支持、最低硬件、性能、正式下载链接、Windows installer数据保留、macOS签名/公证/Gatekeeper和CUDA分发许可仍待真实验收后回填。
- 既有`THIRD_PARTY_NOTICES.local-subtitle.md`未修改，避免在许可closure前改变被runtime manifest固定size/SHA的发布资源；最终notice内容与所有实际发布artifact仍由QA-005复核。

## 下一步建议

- 继续非QA范围时，只处理不依赖目标环境的文档一致性或发现的事实性漂移。
- QA-003～QA-005完成后，使用真实报告替换预发布矩阵中的“候选/待验收”标记，并重新检查所有版本、平台、模型、性能、下载和许可声明，再关闭`DOC-001`。
