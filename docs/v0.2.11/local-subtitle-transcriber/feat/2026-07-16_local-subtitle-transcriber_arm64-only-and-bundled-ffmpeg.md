# 需求变更：macOS arm64-only 与 bundled FFmpeg

> 后续收口：arm64-only 与 bundled FFmpeg 产品结论保持有效；文末关于补独立
> 参考、额外场景和 FasterWhisperGUI/CTranslate2 baseline 的 PRE-001 要求已废弃。
> PRE-001 已按 3 个现有样本完成，见
> `../fix/2026-07-16_local-subtitle-transcriber_reduce-pre001-to-product-readiness.md`。

## 背景

2026-07-16 明确首发 macOS 不需要 x64 支持，只覆盖当前 macOS arm64 环境；后续另行提供 Windows x64 NVIDIA 环境。同时需要回答用户电脑未安装 FFmpeg 时的产品行为。

原设计虽已要求 runner 与 FFmpeg 位于 asar 外并禁止 packaged 模式回退 PATH，但 PRE-001 仍把 macOS x64 列为必测 profile，且对 FFmpeg 缺失时的 build/runtime/UI 修复合同不够完整，容易把“开发机预检依赖”误解为“最终用户前置条件”。

## 最终行为

首发平台矩阵固定为：

| Target profile | 发布能力 |
| --- | --- |
| `mac-arm64-metal` | macOS arm64，Metal 优先，同架构 CPU fallback |
| `windows-x64-cpu` | Windows x64 CPU fallback |
| `windows-x64-cuda` | Windows x64 NVIDIA CUDA |

macOS x64 不生成 runner、安装包或 PoC 报告；预检和未来 runtime 在资源解析前返回 `unsupported_architecture`，不提供 Rosetta 或用户自备 runner fallback。

最终用户无需安装 FFmpeg。正式发行包必须：

1. 将审计后的 macOS arm64 / Windows x64 `ffmpeg` 与 `ffprobe` 通过 `extraResources` 放在 asar 外。
2. 使用版本化、签名覆盖的 runtime manifest 记录 kind、platform、arch、relative path、byte size、SHA-256、版本与 licenseRef。
3. 在打包前验证 runner、ffmpeg、ffprobe、manifest、许可证和源码获取证据；任一缺失即构建失败。
4. packaged 模式只从 `process.resourcesPath` 和 manifest 解析，不回退 PATH、Homebrew、Chocolatey、注册表或用户选择的 executable。
5. 在工具页 probe 和 batch commit 前检查 bundled media runtime，失败时禁用转写，不让任务先入队再逐个失败。

稳定错误与用户操作：

| Error code | 含义 | 用户侧处理 |
| --- | --- | --- |
| `media_runtime_missing` | 文件或 manifest 项缺失 | 检查更新、repair 或重装应用 |
| `media_runtime_invalid` | 签名覆盖、平台/架构、size、SHA-256 或版本无效 | repair、更新或重装可信发行包 |
| `media_runtime_launch_failed` | 静态校验通过但进程无法启动/探测 | 查看脱敏详情，更新或重装 |

上述失败不修改原始媒体；当前窗口存活时保留内存草稿，并保留安全偏好、`<userData>` 模型与已导出字幕。重启/重装后出于 capability 安全边界需要重新选择输入文件。UI 不提供任意 executable picker，也不指导用户修改 PATH。

系统 FFmpeg 仅用于 PRE/开发阶段在 bundled staging 尚未完成前执行媒体 PoC。开发机缺少 FFmpeg 会阻塞当前 PRE 证据采集，但不是最终用户安装要求，也不能用开发机系统 FFmpeg 证明发行包可用。

## 影响范围

- PRE-001 profile/manifest validator 与 Node tests。
- `local-subtitle-transcriber_final_design.md` 的平台、错误、媒体运行时、打包、风险和发布矩阵。
- `local-subtitle-transcriber_execution_plan.md` 的 PRE-004/PRE-005、CORE-001/002、NATIVE-002、MEDIA-001、QA-003/004/005、DOC-001。
- PRE-001 实施记录、v0.2.11 主题台账和 PoC README/第三方候选清单。
- 项目避坑 `FK-PIT-0023`。

## 实施摘要

- 删除 `mac-x64-cpu` profile 和必需报告。
- macOS x64 预检返回稳定 `unsupported_architecture`，并增加回归测试。
- PRE-001 目标报告从四类收敛为三类。
- 文档冻结 bundled FFmpeg 的 build-time、runtime、修复和 packaged QA 合同。
- 不在本变更中下载或提交 FFmpeg、模型、runner 或其他二进制；具体可再分发构建与许可证结论仍由 PRE-005/PRE-006 冻结。

## 验证

```text
node --check scripts/local-subtitle/benchmark/*.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict
git diff --check
```

结果：脚本语法与 16 个 Node tests 通过；macOS arm64 工具链报告 ready；结构校验为 0 error / 8 warning；strict 因尚缺真实证据按预期为 9 errors；无 macOS x64 profile 或发行产物。

后续更新（2026-07-16）：Windows CPU/CUDA 官方预编译 scoped reports 已 ready，3 段真实语料 inventory 已通过；最终收口后 Node tests 19/19，结构与 strict 均为 0 error / 0 warning。上段数字保留为本 feat 首次验收时的历史结果。

## 后续

- 3 段现有真实语料已满足 PRE-001；不再补独立参考、权利证据、额外场景或 baseline 应用/模型 hash。
- macOS arm64 PRE-001 工具链已 ready；后续只需在 PRE-004 使用真实 runner/model、签名身份和 packaged-like bundle 验证 Metal/CPU。
- Windows x64 CPU/CUDA PRE-001 报告已 ready；真实 inference、CUDA ZIP/DLL 和分发仍由 PRE-003/PRE-005/PRE-006 验证。
- PRE-005 选择并审计可再分发 FFmpeg/ffprobe，完成无系统 FFmpeg 的 packaged smoke 与损坏/修复矩阵。
