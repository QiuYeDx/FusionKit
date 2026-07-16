# PRE-001 修正：从科研式 benchmark 收口为产品开发就绪

## 问题

PRE-001 原先逐步加入了英文与额外声学场景、独立校对文本、样本权利证据、
FasterWhisperGUI 应用快照/实际配置、CTranslate2 `large-v3` artifact hash、
CER/WER 和输出一致性要求。这些条件会阻塞 runner 开发，却不是验证最终产品
能否完成中/日音视频本地转写所必需的事实。

根因是把可选的研究型对比方案误升格为产品开发前置门禁，并混淆了三件事：

- 样本能否用于本机开发 smoke；
- FusionKit 是否要复刻另一个 GUI；
- 已完成产品的字幕质量如何由用户验收。

FusionKit 不复刻 FasterWhisperGUI，因此不需要它的快照、配置、CTranslate2
模型或完全一致的输出。文本质量可以在真实 runner 与产品界面完成后人工验证。

## 收口后的 PRE-001 合同

PRE-001 只要求：

1. 当前 3 个真实样本存在且可解码：日文视频、日文 WAV、中文视频；
2. 对应 SRT/LRC 文件存在，格式与时间轴摘要合理且不越过媒体时长；
3. 媒体/字幕只保留在本机，Git 中只记录 sample ID、大小、SHA-256、时长和
   脱敏 probe 摘要；
4. macOS arm64、Windows x64 CPU、Windows x64 CUDA 三份目标环境报告在各自
   PRE-001 scope 下 ready；
5. 校验器和测试通过。

现有 SRT/LRC 的文本不是真值，也不需要与未来输出逐字一致；它们只用于格式、
时间轴 smoke 和产品完成后的人工对照。英语、长文件、噪声、抢话和低音量不是
PRE-001 blocker，可在真实使用中按需要补测。

## 删除的门禁

- 删除 `baseline-profile.json`；
- 删除 FasterWhisperGUI 应用/配置 snapshot 和 CTranslate2 model hash；
- 删除独立参考文本、样本权利/来源审计和额外语料覆盖矩阵；
- 删除 CER、WER、cue boundary MAE 与 baseline profile run identity；
- 删除 `faster-whisper-gui-local-snapshot` 第三方候选；
- 将 `baselineObservedOutput` 改为不承担文本质量门禁的
  `comparisonSubtitle`；
- 将本机 inventory 收敛为 `mediaPath` + 可选 `subtitlePath`。

## 保留的工程边界

- 官方预编译资产的 SHA-256 仍用于防止损坏或替换；
- 后续公开 GGML 模型下载的 SHA-256 只用于文件完整性，不用于复刻 baseline；
- CMake/MSVC 仅在 PRE-002 确实选择本机源码构建时需要，绝不是最终用户依赖；
- FFmpeg、runner、模型和 CUDA 的发行来源、签名与许可证仍由后续分发工作包处理，
  但不再与样本语料 PRE-001 混在一起。

## 验证

```text
node --check scripts/local-subtitle/benchmark/validate-manifests.mjs
node --check scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
git diff --check
```

结果：19/19 tests 通过；普通与严格清单均为 0 error / 0 warning；
`git diff --check` 通过。

## 结论

PRE-001 已完成，无剩余 blocker。下一工作包为 PRE-002：最小 CPU persistent
runner 与 JSONL 协议 PoC。
