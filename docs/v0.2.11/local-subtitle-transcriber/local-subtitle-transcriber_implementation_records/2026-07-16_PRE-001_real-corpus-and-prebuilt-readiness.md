# 工作包 PRE-001：真实语料证据与 Windows 预编译就绪修正

> 2026-07-17 后续：PRE-002 已直接使用官方预编译 `whisper-server.exe` 完成，
> 因此下文关于“自有 runner 构建环境尚未 ready”的历史状态不再是当前 blocker。

> 最终收口（2026-07-16）：本记录中把独立真值、样本权利证据、额外场景和
> FasterWhisperGUI/CTranslate2 baseline 视为 blocker 的结论已废弃。当前有效结论
> 见 `2026-07-16_PRE-001_scope-reduction-and-completion.md`：现有 3 个样本足够，
> PRE-001 已完成。

## 基本信息

- 日期：2026-07-16
- 状态：已完成（历史阶段记录；最终结论见范围收口记录）
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-001`
- 目标环境：Windows 11 x64、Intel Core i5-13600KF、NVIDIA GeForce RTX 4070 Ti SUPER 16 GB

## 本次认领边界

- 包含：只读盘点用户放置的 3 段媒体和 3 份 FasterWhisperGUI 字幕输出；采集媒体/hash/timeline 证据；建立 Git 忽略的本机 inventory；修正 Windows 官方预编译 PoC 与源码构建 readiness；刷新报告、门禁、设计、计划和避坑记录。
- 不包含：修改或复制原始语料、把字幕正文/绝对路径提交进 Git、把模型输出冒充人工真值、下载 `large-v3`、执行完整转写、进入 PRE-002/PRE-003、实现 runner/runtime/UI，或证明 CUDA/FFmpeg 最终分发可用。

## 本次实现内容

### 真实语料

3 段媒体均以只读方式完成 FFprobe、完整音轨解码、SHA-256、音量/静音摘要和对应字幕时间轴检查：

| Sample ID | 语言/容器 | 时长 | 字节数 | 音频/字幕摘要 |
| --- | --- | ---: | ---: | --- |
| `ja-character-pv-bgm-medium` | 日文 MP4 | 230,230 ms | 51,775,477 | H.264 + AAC 48 kHz stereo；SRT 75 cues，2,610～221,840 ms |
| `ja-audio-drama-frequent-silence-medium` | 日文 WAV | 753,390 ms | 216,976,508 | PCM S24LE 48 kHz stereo；LRC 129 timestamps，6,320～732,040 ms；`-40 dB/2 s` 下 36 段静音、合计 107.893 s |
| `zh-character-pv-bgm-medium` | 中文 MP4 | 235,222 ms | 55,682,295 | H.264 + AAC 48 kHz stereo；SRT 74 cues，7,540～227,780 ms |

- 三份字幕均为 UTF-8 BOM + LF，时间戳单调、范围有效且不越过媒体时长。
- 两段 character PV 的 `bgm` 分类目前依据节目类型标为 provisional，尚未做人工听审；日文 WAV 的 `frequent_silence` 由固定阈值 probe 直接支持。
- manifest 只保存稳定 sample ID、duration/size/hash、媒体 probe 摘要和 baseline output hash/timeline；不保存文件名、路径或字幕正文。
- FasterWhisperGUI 生成的 SRT/LRC 进入 `baselineObservedOutput`，状态为 `captured_unverified_configuration`。它们没有被写入 `referenceTranscript.sha256`，因为同一模型输出不能作为独立 CER/WER 真值。
- 3 个样本状态为 `partial_evidence`：媒体证据已验证，但独立参考文本和可审计使用/权利依据仍缺失。
- 确定性 10 秒静音 WAV 已生成到 `fixtures.local`；本机 `sample-inventory.json.local` 包含 3 对媒体/baseline 输出和 synthetic fixture，物理 hash 校验通过。

### Windows readiness 修正

- PRE-001 Windows CPU/CUDA 改为 `readinessScope: official_prebuilt_release_asset`。
- CPU 固定 `whisper.cpp v1.9.1 / whisper-bin-x64.zip`，7,982,101 bytes，SHA-256 `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539`。
- CUDA 固定 `whisper-cublas-12.4.0-bin-x64.zip`，677,887,125 bytes，SHA-256 `106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b`。
- CMake、MSVC 与 `nvcc` 仍被探测，但进入独立 `sourceBuild`；Windows `sourceBuild.requiredForPoc=false`，所以 CMake/MSVC 缺失不再阻塞 PRE-001，也不成为最终用户前置。
- 两份 Windows 报告已重生成并为 `ready: true`，同时如实保留 `sourceBuild.ready: false`。
- CPU ZIP 已在 Git 忽略目录完成本机下载 hash 校验和 `whisper-cli.exe --help` smoke，退出码 0。CUDA ZIP 本次未下载，只有上游 release digest 证据，不能据此宣称 CUDA inference 或 DLL 分发已验证。
- macOS arm64 仍为 `source_build_poc`，原有 CMake/Clang/Xcode/Metal 报告保持 ready。

## 修改文件

- `scripts/local-subtitle/benchmark/preflight.mjs`
- `scripts/local-subtitle/benchmark/preflight.test.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.test.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/*`
- `docs/v0.2.11/local-subtitle-transcriber/poc/reports/*`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-16_local-subtitle-transcriber_split-prebuilt-runtime-and-source-build-readiness.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/keep-windows-native-preflight-command-resolution-explicit.md`
- `.agents/skills/fusionkit-pitfall-guard/references/separate-official-prebuilt-poc-readiness-from-source-build-toolchains.md`

## 接口、状态或数据结构变化

- toolchain report schema 仍为 v1，但新增 `readinessScope`、固定 `pocArtifact` 和独立 `sourceBuild`；validator 按目标验证 scope、build 状态和官方 asset pin。
- `benchmark-manifest.evidenceStatus` 新增 `partial_evidence`；该状态必须有完整媒体 size/hash、匹配 duration class 和 `mediaEvidence.status=verified`，但严格门禁仍失败。
- 真实样本新增 `baselineObservedOutput`，同时 `baseline-profile.observedOutputs` 与其 hash 双向耦合校验。
- inventory 只要求验证 `partial_evidence`/`ready` 样本，允许尚未选择的 scenario slot 不含路径；baseline output 使用 `baselineOutputPath` 做 raw hash/size 复核。
- 严格门禁仍要求样本最终为 `ready`、独立 reference hash、verified license/source evidence 以及冻结的 baseline 应用/模型 hash。

## 安全、隐私与许可证检查

- 原始媒体/SRT/LRC 未修改、未复制进仓库；绝对路径只存在于 `.local` inventory。
- `git check-ignore -v` 已确认 inventory、synthetic fixture、CPU ZIP 和展开后的 exe/DLL 都被 `*.local` 忽略。
- 提交范围只含 hash、字节数、时长、codec、聚合音量/静音和时间轴计数，不含字幕正文、文件名、hostname、username、凭据或完整环境。
- 用户已授权本次本机评估，但没有提供媒体所有权/许可/来源记录；因此 license 状态保持 `local_evaluation_rights_unverified` / pending，不能标记 ready 或再分发。
- 官方 CPU/CUDA 资产仍是 PoC 候选。CPU launch smoke 不替代 PRE-006 的许可证、签名、来源、可重现构建和 clean-machine 审计。

## 验证结果

执行命令：

```text
node --check scripts/local-subtitle/benchmark/preflight.mjs
node --check scripts/local-subtitle/benchmark/validate-manifests.mjs
node --check scripts/local-subtitle/benchmark/generate-synthetic-fixtures.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
git diff --check
```

结果：

- 通过：3 个脚本语法检查；Node tests 23/23；3 段媒体音轨完整解码；3 份字幕 timeline 检查；本机 inventory hash/size/path-case 校验；结构门禁 0 error / 7 warning；三份 scoped target report ready；官方 CPU ZIP SHA-256 + help launch smoke。
- 当时严格门禁按旧研究型合同预期失败，且没有 inventory、report、path、size 或 hash 错误；该合同随后被删除，最终严格校验为 0 error / 0 warning。
- 未运行及原因：没有独立参考真值、冻结的 baseline 应用/模型或 PRE-002 runner，因此不运行 CER/WER、RTF、RAM/VRAM、模型复用、取消和真实 CUDA inference。
- 真实硬件/packaged 范围：验证了 Windows 主机 probe 与 CPU 预编译 CLI 启动；未验证 CUDA ZIP、模型加载、packaged app、bundled FFmpeg/CUDA runtime、签名或 clean machine。

## 产生的证据

- 当时提交证据包含 `poc/baseline-profile.json`；该研究型合同已在最终收口中删除。当前版本化证据为 `poc/benchmark-manifest.json`、`poc/metrics-contract.json`、`poc/third-party-candidates.json` 和 3 份脱敏 target report。
- 本机证据：`sample-inventory.json.local`、`fixtures.local`、`runtime-smoke.local`；全部 Git 忽略，不应 stage/commit。
- 原始语料仍保留在用户指定目录，本次没有修改或清理用户文件。

## 当时未完成事项与风险（已被最终收口取代）

- 当时计划补独立参考、样本权利依据、英文/额外声学场景和 FasterWhisperGUI/CTranslate2 baseline；最终范围评审确认这些不服务于 PRE-001 的产品开发决策，已全部删除。
- CUDA ZIP 未下载、未启动、未加载模型；Windows CUDA 支持仍必须由 PRE-003/PRE-005/PRE-006 完整验证。
- PRE-002 自有 runner 的构建环境尚未 ready。进入该包后再选择安装 CMake/MSVC 或使用受控构建机，不提前把它变成 PRE-001 blocker。

## 最终交接

当前 3 个样本已标记 ready，严格门禁为 0 error / 0 warning；PRE-001 已完成，下一步进入 PRE-002。
