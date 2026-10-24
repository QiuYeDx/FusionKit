# 实施记录：T-ASRQ-14

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-14 |
| 日期 | 2026-10-25 |
| 验证版本 | 工作树，基于 8c0980a6（未提交），本步骤没有改代码。文件哈希：`electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts`（sha256 0bc24af7…，修剪的判定与 `trimmedEdge` 诊断，同文件里还有 T-ASRQ-16 的时间锚点与门槛）、`electron/main/subtitle-studio/transcription/transcript-executor.ts`（e0859f89…，经 `dropLocalSubtitleSeamDuplicates` 执行修剪，不新增 import）、`scripts/subtitle-studio-provenance/current-copy-audits.json`（59decea2…）、`test/subtitle-studio/transcription/seamDuplicates.test.ts`（85da0615…）、`test/subtitle-studio/transcription/productionExecutor.test.ts`（1285ddef…）、`test/asr-quality/ab-comparison-harness.ts`（00749fd6…，记录 `trimmedEdge`）。真实重跑与 T-ASRQ-16 是同一次 run-8YtcFr（2026-10-25 03:17:21–03:27:21 +0800）。证据：`records/T-ASRQ-14-unit.txt`、`records/T-ASRQ-14-provenance.txt`、`records/T-ASRQ-14-rerun.txt`；上一次重跑 run-lGjDZk 的核对另存为 `records/T-ASRQ-14-rerun-lGjDZk.txt` |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；NVIDIA GeForce RTX 4070 Ti SUPER 16 GB（驱动 610.88）；内置运行时 `build/subtitle-studio-resources/transcription`（whisper.cpp v1.9.1，运行时代 3a2ac09dfc9b…，含 FFmpeg，100 ms RMS 也用它解码）；模型 large-v3（SHA-256 64d182b4…）与 CUDA 包只读；设备 CUDA；开跑前没有 ZenlessZoneZero.exe；没有启动 Electron 或任何窗口，没有结束任何进程 |
| 任务指纹 | ba440355f2c9c3c463fd61f561131d1850250a482a87ef6f7dac51dde8cd644b |

## 实际结果

修剪保留长句的重复开头（AC-ASRQ-14-6）在 T-ASRQ-16 加了门槛之后的代码上重新核对过：单元测试、provenance 与类型检查都通过，并在与 T-ASRQ-16 同一次的真实重跑 run-8YtcFr 里逐条核对。27 个用例的诊断里只有 2 条 `trimmedEdge`，与上一次重跑是同样两处，两条都对，没有别处被修剪。pv-ja 嘈杂·音乐音效 177.42 s 那一句开头的重复不再出现：保留的长句去掉了与上一句全文相同的 20 个字素（连同顿号），起点停在上一句的终点 177.42 s，剩下的字与以前一字不差，切法与同一处的低音量·耳语相同。现在上一句所在的窗口不再改时间，这一句的起点与修复前相同；上一次重跑是 177.49 s，那 0.07 s 来自当时锚点改了上一句的时间。另一条在 full 标准模式 142.48 s：远端保护留下的那一句结尾，有一个词与下一句全文相同，现在去掉了；100 ms 音量显示这个词只在下一句的位置说了一遍，修剪是对的。这是标准模式与修复前唯一不同的一句，AC-ASRQ-15-3 现在明确不计这处修剪。

### 实现（design 方案 8“修剪保留长句的重复开头”；本步骤没有改代码）

- 判定在后处理里做。`findSeamDuplicates` 记下远端保护留下的那份（`farEndKept`）。某条去重判定的保留句里有这份时：
  - 先取它靠接缝一端旁边、还在的相邻句（跳过已去掉的）；
  - `trimRepeatedSeamEdge` 检查这一端的原文：规范化后与相邻句全文相同、并且在标点或空白处断开，才去掉这段（连同断开处的标点与空白）。
  - 夹在两个字母或数字之间的撇号、连字符、点号算在词内，不算断开。
  - 去掉后剩下的字少于下限（2 个 CJK 字或 4 个拉丁字符）时不动。
  - 这一端移到相邻句的终点（开头的情形）或起点（结尾的情形），只往外移。按另一端移回或修剪后的时间算，不超过最长字幕时长。
- 执行在 Studio 执行器里，由 `dropLocalSubtitleSeamDuplicates` 完成。
  - 相邻句与保留句的时间和文字都必须与报告时相同；被 CUDA 修复改过的不动。
  - 实际执行的修剪作为 `trimmedEdge` 返回（cueId、edge、removedChars、fromMs、toMs，不含文字），生产环境不保存。对照工具把它记进每个用例的 JSON。
- 其他去重判定不变。复制来的 T02 执行器不调用去重，也就不修剪。
- 审计：subtitle-post-processor.ts、transcript-executor.ts、productionExecutor.test.ts 的 currentSha256 与原因已更新（最近一次是 T-ASRQ-16 门槛的 2026-10-25）。三个文件都是 LF；冻结副本没有改。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-14-1 | 通过 | file:records/T-ASRQ-14-unit.txt |
| V-ASRQ-14-2 | 通过 | file:records/T-ASRQ-14-provenance.txt |
| V-ASRQ-14-3 | 通过 | file:records/T-ASRQ-14-rerun.txt |

- V-ASRQ-14-1（2026-10-25 03:07 重跑）：seamDuplicates.test.ts 45 个用例全过，productionExecutor.test.ts 的 “Studio seam duplicates” 3 个用例全过。覆盖的情形：
  - 开头与上一句完全相同、在标点处断开时去掉并移起点；结尾的对称情形；
  - 不完全相同、不在标点或空白处断开、剩下的字少于下限、相邻句已去掉或改过、不是远端保护留下的那份时都不动；
  - 原有的去重判定不变。
- V-ASRQ-14-2（2026-10-25 03:12–03:16 重跑）：
  - 审计文件 sha256 与 currentSha256 相同，都没有 CR；copy.mjs --check 与 transcript-executor-copy.mjs --check 通过。
  - provenance 16 个文件 233 个用例通过（2 个文件、3 个用例按条件跳过），默认路径回放不变。
  - test/subtitle-studio/transcription/ 33 个文件 821 个用例通过；非 UI 的 transcription-*.test.ts 15 个文件 234 个用例通过（不含会启动 Electron 的 transcription-bridge.test.ts）；ab-report.test.ts 20 个用例通过。
  - tsc --noEmit -p tsconfig.json 通过。
- V-ASRQ-14-3（run-8YtcFr）：2 条 `trimmedEdge` 逐条核对：
  - removedChars 与按前后文字重算的字素数相同；
  - 去掉的那段规范化后与相邻句全文相同；
  - 这一端贴着相邻句；
  - 其余字一字不差。
  - pv-ja 嘈杂 177.42 s 的重复开头不再出现。full 标准模式那一条重新用 RMS 核对过是对的。没有别处被误剪。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-14-6 | 通过 | V-ASRQ-14-1, V-ASRQ-14-3 |

- 单元测试覆盖了该修剪与不该修剪的各种情形（V-ASRQ-14-1）。
- 真实重跑里只有两处修剪，都符合条件；pv-ja 嘈杂·音乐音效 177.42 s 那一句开头的重复不再出现，这一端停在相邻句终点（V-ASRQ-14-3）。

## 风险与未执行项

- 用户还没有听审修剪结果。T-ASRQ-17 的听审页面要把 177.42 s 这一处放进去；full 标准模式 142.48 s 那一处也建议一起听。页面应改用 run-8YtcFr，177.42 s 那句的起点已经回到 177.42 s。
- 修剪会改标准模式的输出（full 142.48 s 一句）。需求里 AC-ASRQ-15-3 已改为不计这处修剪，标准模式其余输出与修复前逐句相同。
- 真实数据里只出现了 2 次修剪，不完全相同、不在标点处断开等不动的情形只有单元测试覆盖。
- pv-zh 嘈杂 177.50 s 有两条新的去重判定，是 T-ASRQ-16 仍改那一窗口的时间造成的，不是修剪。上一窗口那份开头的 1 个语气词随之没有了，标准里也没有这个字；上一次重跑在这里回来的接缝重复，本次没有了（见 records/T-ASRQ-16-rerun.txt (b) 节）。
- pv-ja 177.42 s 那一处有背景音乐，RMS 判断不了人声起止；这一句的终点 181.00 → 182.96 s 来自 T-ASRQ-16 改了下一窗口的时间，不是修剪。
- 生产环境不保存 `trimmedEdge`，用户在 Studio 里看不到哪一句被修剪了。
- tsc -p tsconfig.json 只包含 src 与 electron，不检查测试文件；seamDuplicates.test.ts 与 productionExecutor.test.ts 只由 vitest 运行覆盖，本步骤没有另做它们的类型检查。
- tasks.md 的状态与完成日期没有改，不在本步骤范围内。改动没有提交。
