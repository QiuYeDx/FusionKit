# 工作包 PRE-001：范围收口与完成

> 2026-07-17 后续：下文的 PRE-002 建议已由 Node-managed official
> `whisper-server` 方案完成，自写 C++/JSONL runner 与 CMake/MSVC 不再是首版前置。

## 基本信息

- 日期：2026-07-16
- 状态：已完成
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-001`
- 目标环境：macOS arm64；Windows 11 x64 CPU / NVIDIA CUDA profile

## 本次认领边界

- 包含：把 PRE-001 从研究型比较基线收口为产品开发启动门禁；使用现有 3 个
  中/日真实样本完成本机 integrity/timeline 校验；简化 manifest、metrics、
  inventory、validator 和 tests；统一 Final Design、Execution Plan 与版本台账。
- 不包含：下载 GGML 模型、编译自有 runner、执行真实转写/CUDA inference、实现
  runtime/UI、冻结最终 FFmpeg/CUDA/模型分发与许可结论。这些从 PRE-002 起按实际
  产物推进。

## 本次实现内容

- `benchmark-manifest.json` 状态改为 `ready_for_development`，真实范围固定为
  3 个样本、日语/中文、音频/视频、SRT/LRC。
- 3 个真实样本改为 `ready`；保留媒体 size/hash/duration/probe 和字幕
  size/hash/timeline，不再要求独立 transcript 或样本 license evidence。
- 现有字幕字段改为 `comparisonSubtitle`，明确
  `manual_smoke_reference_only` 与 `textAccuracyGate=false`。
- 删除 `baseline-profile.json` 及 FasterWhisperGUI/CTranslate2 baseline 校验。
- metrics 删除 CER/WER/cue boundary MAE、`baseline_profile_id` 和
  `model_sha256` 前置；模型只用 `model_id` 记录运行选择。
- inventory 字段改为 `mediaPath` / `subtitlePath`；本机路径继续由 `.local`
  ignore 保护。
- validator 只校验 3 样本产品 scope、文件完整性、字幕时间轴、目标报告和隐私；
  tests 相应改为最小合同。
- 设计、计划、主题 README、版本台账和历史记录统一标明 PRE-001 已完成，下一步
  为 PRE-002。

## 接口、状态或数据结构变化

- 删除文档键：`baseline`、`requiredCoverage`、`referenceTranscript`、`license`、
  `baselineObservedOutput`。
- 新增/替换：`acceptanceScope`、`sampleKind`、`comparisonSubtitle`、
  inventory `subtitlePath`。
- `validateDocuments(..., { strict: true })` 对当前提交合同返回 0 error / 0 warning；
  CLI strict 仍要求 ignored local inventory，保证本机样本没有被误删或替换。

## 安全、隐私与许可证检查

- 路径/capability：没有把用户指定语料目录或其他绝对路径写入版本化
  文件；绝对路径仅存在于 ignored `sample-inventory.json.local`。
- 日志/持久化：manifest 不含媒体/字幕正文，inventory 错误只返回 sample ID 和
  字段名，不回显路径。
- 第三方来源与许可：移除不需要的 FasterWhisperGUI baseline 依赖。官方 runner
  与未来 GGML model hash 仅作下载/资产完整性；最终发行审计仍由后续工作包负责。

## 验证结果

执行命令：

```text
node --check scripts/local-subtitle/benchmark/validate-manifests.mjs
node --check scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
git diff --check
```

结果：

- Node tests：19/19 通过；
- 普通 manifest/report 校验：0 error / 0 warning；
- strict + 本机 3 样本 inventory：0 error / 0 warning；
- `git diff --check`：通过；
- 3 份目标报告保持 ready；Windows source build 仍如实为未就绪，但
  `requiredForPoc=false`，不构成 PRE-001 blocker。

## 产生的证据

- 版本化合同：`poc/benchmark-manifest.json`、`poc/metrics-contract.json`、
  `poc/third-party-candidates.json`；
- 脱敏环境报告：`poc/reports/*.json`；
- 本机样本路径：`poc/sample-inventory.json.local`（Git 忽略，不提交）；
- 范围决策：
  `fix/2026-07-16_local-subtitle-transcriber_reduce-pre001-to-product-readiness.md`。

## 未完成事项与风险

- PRE-001 无未完成事项。
- 尚未有自有 runner 或真实模型推理是 PRE-002/003 的正常起始状态，不是
  PRE-001 blocker。

## 下一步建议

- 进入 PRE-002：选择最短可行的 whisper.cpp runner 构建路径，实现
  `hello/load_model/transcribe/cancel/unload/shutdown` JSONL 最小闭环，并连续处理
  至少两个当前样本。
- 仅在本机源码构建确实是最短路径时安装 CMake/MSVC；否则使用受控构建机或
  其他可重复构建路径。
