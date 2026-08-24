# 修复设计：整段 whisper-server 请求进入重复 decoder 状态

> 状态：已修复并由 PRE-004 Metal/CPU 三样本矩阵验收（2026-07-17）。

## 背景与观察

PRE-004 首轮 macOS arm64 PoC 把 backend、RTF、RSS、语言检测和 SRT/LRC
parse-back 全部记录为通过。用户检查 ignored local 结果后发现字幕存在连续几十到
数百行重复，并且重复期间的真实语音没有被识别。

问题不是 Metal 独有，但 Metal 症状更严重：

| backend / 样本 | 失效证据 |
| --- | --- |
| Metal / 日文长音频 | 从 405.52 s 起连续 347 段重复同一句直到 753.52 s；该句总计出现 352 次，后半段真实语音丢失 |
| Metal / 中文 PV | 63.86～217.86 s 连续 77 段重复同一句 |
| Metal / 日文 PV | 196.60～225.60 s 连续 14 段重复同一句 |
| CPU / 中文 PV | 61.80～106.88 s 连续 43 段重复同一句 |
| CPU / 日文长音频 | 多处重复与零时长 segment；最后 cue 到 781.28 s，超过 753.39 s 媒体末尾约 27.89 s |

首轮 `allSubtitleParseBackPassed=true` 仅证明 formatter 输出能被自身 parser 回读，
不能证明字幕覆盖或内容有效。早期只抽查每个结果的开头几段，未检查后半段，因此得到
了错误的功能结论。

## 定位结论

1. 重复在上游 `verbose_json` 原始 segment 中已经存在；TypeScript
   `createSmokeCues()` 和 SRT/LRC formatter 没有引入这些文本。
2. FFmpeg 转换得到完整 16 kHz mono WAV，server 报告的音频时长与 FFprobe 一致；
   故障区间的源音频和参考字幕均包含持续变化的真实语音，不是文件截断或纯静音。
3. 关闭 `token_timestamps` 后中文 Metal 最长重复从 77 段增加到 131 段；关闭
   flash attention 仍重复 65 段；`max_len=1000` 仍重复 131 段。这三项都不是独立
   根因。
4. 同提交、同模型、同 Metal 的 `whisper-cli` 默认 beam search 不再出现数十段
   循环，但开头 30 秒产生了另一条常见幻觉，说明单纯改成 beam search 也不是完整
   修复。
5. official server 加 `beam_size=5` 后，中文最长连续重复降为 3 段，但同样把开头
   30 秒误写为常见网络视频结尾文案。
6. 保持原 greedy 参数，把中文 `0～30 s`、`60～90 s` 和日文长音频
   `405～435 s` 分别作为独立窗口请求时，三个窗口都恢复为与参考时间轴对应的连续
   内容。由此确认直接故障面是整段单请求 decoder 状态在后续内部窗口锁死；Metal
   数值路径改变了锁死程度，但 backend、模型文件和媒体本身仍可正确处理故障窗口。

## 合同修正

- PRE-004 的 Metal/CPU backend、RTF/RSS、模型复用、取消、thin arm64 artifact、
  系统依赖、可执行位和 packaged-like 验证继续记为通过。
- Developer ID、notarization 和 Gatekeeper accepted 不再是 PRE-004 blocker；它们
  属于未来公开无警告分发能力，由 `QA-004` 在真实发布产物上验收。
- 诊断阶段 PRE-004 整段字幕有效性改为未通过并保持 `进行中`；最终已由相同 3 个
  样本的 Metal/CPU raw transcript validity 与 parse-back 联合门禁解除。
- 旧 RTF 只代表错误整段策略的计算速度，不能作为最终分块策略的产品性能结论。

## 已实现修复方案

没有用“删除重复行”伪装修复。最终实现采用以下路径：

1. 媒体先由 FusionKit 规范化为受控 16 kHz mono PCM，不让 server 为每个窗口重复
   转换整段输入。
2. 使用约 30 秒的有界推理窗口和小幅 overlap；每个窗口是独立 decoder 请求，但
   model/server 进程继续驻留。
3. 合并时按绝对整数毫秒处理 overlap、边界 cue 和重复文本；禁止简单按字符串全局
   去重。
4. 在 raw segment 层检查连续重复的 cue 数/持续时间、零/负时长、重叠、倒退、超出
   媒体时长和窗口覆盖缺口。
5. 窗口命中退化门禁时，最多递归拆短 3 层；重试仍失败则返回稳定内容质量错误，
   不提交看似成功的字幕。
6. 重新采集 Metal/CPU RTF、RSS、取消延迟和复用；窗口化开销进入真实产品提示。

VAD 确认能减少静音诱发的幻觉，但它不是整段 decoder loop 的替代修复。v1.9.1 的
segment 时间已映射回原媒体，token/word 时间仍处于去静音后的压缩时间轴；因此 VAD
请求强制 `token_timestamps=false`，只使用 segment 时间，merge 再拒绝越出 parent
segment 的 word 时间并回退。这个差异已有 supervisor 与 merge 两层回归测试。

## 完成结果

- Metal 三样本 RTF 0.0698～0.0821，CPU 0.1954～0.2811，全部快于实时。
- 最长连续重复从历史 347/77/43 段降为最多 2 cue；所有 raw 时间轴错误、越界和
  覆盖缺口均为 0。
- 日文长音频 `600～630 s` 静音窗口返回 0 段，约 638.70 s 的后续真实台词与
  738.84 s 媒体尾部均恢复；没有通过删除重复文本隐藏漏识别。
- 语言检测、SRT/LRC parse-back、同进程模型复用、取消、backend 与清理全部通过。

## 影响文件

- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/whisper-server/run-poc.mjs`
- `scripts/local-subtitle/whisper-server/subtitle-smoke.mjs`
- 计划中的 `electron/main/local-subtitle/media-normalizer.ts`
- 计划中的 `electron/main/local-subtitle/subtitle-post-processor.ts`
- `local-subtitle-transcriber_final_design.md`
- `local-subtitle-transcriber_execution_plan.md`
- `poc/pre004-macos-arm64-results.json`

## 验收要求

3 个真实样本的 Metal/CPU 矩阵已重新运行并同时满足：

- raw segment 时间轴为正、单调且不越过 FFprobe duration 容差；
- 不存在跨越 30 秒以上或 8 个以上 cue 的同文连续重复而未被显式判定；
- 每个窗口有覆盖证据，退化窗口的 retry/失败状态可追踪；
- 故障区间人工抽查与用户提供的 SRT/LRC 时间轴内容一致到开发 smoke 级别；
- SRT 和标准 LRC 在内容有效性通过后再做 parse-back；
- Metal/CPU backend 证据、模型复用、取消、清理和新策略 RTF/RSS 重新通过。

阈值是 fail-fast 启发式，不是准确率指标；合法重复台词可人工确认，但不得静默放行
长时间 decoder loop。

## 诊断与最终验证命令

```text
node <read-only local analyzer> <ignored PRE-004 result JSON files>
whisper-server <Metal baseline> + token_timestamps=false
whisper-server <Metal --no-flash-attn>
whisper-server <Metal baseline> + max_len=1000
whisper-server <Metal baseline> + beam_size=5
whisper-server <Metal baseline> + offset/duration bounded windows
whisper-cli <same v1.9.1 build/model/Metal> <normalized Chinese sample>
node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/*.test.mjs
node scripts/local-subtitle/whisper-server/run-poc.mjs <final Metal/CPU windowed arguments>
```

所有原始诊断仍位于 ignored local storage；本文只保留脱敏计数、区间和结论。
