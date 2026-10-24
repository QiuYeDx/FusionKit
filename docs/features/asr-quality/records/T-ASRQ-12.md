# 实施记录：T-ASRQ-12

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-12 |
| 日期 | 2026-10-24 |
| 验证版本 | 工作树，基于 748285ec（未提交）。修改：`src/subtitle-studio/transcription-review.ts`（sha256 a5ec35e8…）、`test/subtitle-studio/transcription-review.test.ts`（4362b4fa…）；`src/locales/en/studio.json`、`src/locales/ja/studio.json`、`src/locales/zh/studio.json`、`src/locales/zh-Hant/studio.json`（各改一行，只改 `cue_review.details.duplicate_neighbor`，改为“相同或几乎相同”，由协调者改）；记录与证据：`records/T-ASRQ-12.md`、`records/T-ASRQ-12-unit.txt`、`records/T-ASRQ-12-stats.txt`。tasks.md 中本任务写集原写作 `src/locales/*/studio.json`，规格检查不接受通配符，已改为上面四个文件路径。统计用的真实输出：run-2512BY（去重前）、run-SVKkhx（第一版去重）与 run-Gg6ITS（2026-10-24 17:14 的重跑，远端保护 + 移回被裁的一端，见 records/T-ASRQ-11.md） |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；esbuild 0.21.5（把工作树版与 git HEAD 版的 `transcription-review.ts` 分别打包给 node，vite-node 无法加载本仓库的 Electron vite 配置）；统计不需要 GPU，也没有启动 Electron |
| 任务指纹 | 3fc427db05278710c5962a9e5a3120a95d9bb108a467204267245b76fc381657 |

## 实际结果

`duplicate_neighbor` 按 design 复核规则表扩展。只和紧挨着的上一句比较，间隔仍须小于 1 s。在“规范化文本相同、至少 6 字”之外，新增两种情况：较短一句至少 5 字，并且被较长一句包含；两句都至少 6 字，并且编辑距离相似度（1 − 编辑距离 / 较长一句长度）不低于 0.8。规则模块仍是纯函数。2026-10-24 17:13 重跑单元测试，20 个用例全部通过。真实输出上，HEAD 规则在三次运行上都标 0 句。新规则在修复前（run-2512BY）标出 10 句，全是窗口接缝重复，两版去重都在每一对里去掉了一句；在第一版去重（run-SVKkhx）上标 0 句。在本次重跑（run-Gg6ITS）上标 1 句：pv-ja / noisy_music_v1 的 177.42–181.00，它包含上一句 173.72–177.42。这正是 design 方案 8 预期的情形：远端保护留下了较长的那份拷贝，更早一句没被裁剪、与长拷贝开头相同，不是去重候选，由这条规则的包含条件标出。语气词和其他正常句子没有被标出。

### 规则与阈值

- `CUE_REVIEW_THRESHOLDS` 新增 `duplicateContainedMinChars: 5`、`duplicateSimilarMinChars: 6`、`duplicateMinSimilarity: 0.8`，与原有的 `duplicateMinChars: 6`、`duplicateMaxGapMs: 1000` 放在一起。
- 两句文字完全相同时，只按原来的“至少 6 字”判断，所以同一个 5 字短句说两遍不会被标（单元测试固定了这一行为）。
- 编辑距离按码位计算，用两行表实现。长度差，或某一行的最小值已经不可能达到 0.8 时提前结束；判断用的是同一个浮点表达式，所以结果是精确的。
- 四种语言的原因说明改为“与上一句文字相同或几乎相同且紧挨着”及对应译文，短标签“与上一句重复”不变。四个文件都能被 JSON 解析，都是 LF。

### V-ASRQ-12-1 单元测试

records/T-ASRQ-12-unit.txt（2026-10-24 17:13 重跑）：`transcription-review.test.ts` 18 个、`transcription-review-ipc.test.ts` 2 个，共 20 个用例全部通过；同样调用 `reviewCue` 的 `cue-recognize.test.ts` 10 个通过，1 个按环境变量跳过（真实模型识别）。`npx tsc --noEmit -p tsconfig.json` 通过。覆盖的情形：

- 包含关系两个方向都会标，包括英文一例和 5 字边界（4 字不标）。
- 只差一两个字会标：假名换汉字、词尾不同、6 字差 1 字、10 字差 2 字（正好 0.8），以及需求里人名一例的同形用例（中间点加两个同音字）。相似度 0.7、6 字差 2 字和无关句子不标。
- 时长被压缩的接缝拷贝同时得到 abnormal_rate 与 duplicate_neighbor；时间重叠的两句也会标。
- 短语气词不标（うん/うん、はい/はい、うんうん、はいはい、ええ、そうそう(そう)、なるほど(ね)）。
- 间隔 999 ms 会标，正好 1000 ms 不标，三种规则都一样。
- 文档级只和紧挨着的上一句比较：隔一句的近似重复不标。

### V-ASRQ-12-2 真实输出统计（9 段样本合计，records/T-ASRQ-12-stats.txt）

用 `reviewDocument`（主进程 cue-review.ts 调用的同一个入口，deflate 压缩比），文档语言按样本固定，置信度取自转写。esbuild 打包在 17:13 按当前工作树重做。

| 规则 | 运行 | 变体 | 字幕 | 有标记 | low_confidence | repetition_loop | abnormal_rate | duplicate_neighbor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HEAD | run-2512BY | standard | 363 | 17 | 10 | 1 | 6 | 0 |
| HEAD | run-2512BY | quiet_whisper_v1 | 351 | 24 | 14 | 1 | 11 | 0 |
| HEAD | run-2512BY | noisy_music_v1 | 336 | 15 | 6 | 1 | 9 | 0 |
| 工作树 | run-2512BY | standard | 363 | 18 | 10 | 1 | 6 | 1 |
| 工作树 | run-2512BY | quiet_whisper_v1 | 351 | 25 | 14 | 1 | 11 | 4 |
| 工作树 | run-2512BY | noisy_music_v1 | 336 | 19 | 6 | 1 | 9 | 5 |
| 工作树 | run-SVKkhx | standard | 358 | 15 | 10 | 1 | 4 | 0 |
| 工作树 | run-SVKkhx | quiet_whisper_v1 | 343 | 18 | 14 | 1 | 5 | 0 |
| 工作树 | run-SVKkhx | noisy_music_v1 | 327 | 11 | 6 | 1 | 5 | 0 |
| 工作树 | run-Gg6ITS | standard | 358 | 15 | 10 | 1 | 4 | 0 |
| 工作树 | run-Gg6ITS | quiet_whisper_v1 | 343 | 16 | 14 | 1 | 3 | 0 |
| 工作树 | run-Gg6ITS | noisy_music_v1 | 327 | 9 | 6 | 1 | 2 | 1 |

phantom_phrase 与 non_speech_only 在所有行都是 0。HEAD 规则在 run-SVKkhx 与 run-Gg6ITS 上，除 duplicate_neighbor 为 0 外，其余数字与工作树规则相同。

- 修复前（run-2512BY）：新规则只多出 10 个 duplicate_neighbor 标记，其他原因的计数不变。其中 6 句原来没有任何标记，所以“有标记”分别多 1、1、4 句。这 6 句是时长正常的近似重复，例如听审 #7 那条 1.8 s 的变体（pv-zh / noisy 52.50–54.30，相似度规则，11/11 字），原规则漏掉的正是这一类；另外 4 句本来就因时长被压缩而有 abnormal_rate。抽查：在本机的 `test-results/asr-quality-ab/run-Gg6ITS/seam-dedup-compare.md` 里逐句读了这 10 对的文字。间隔都是 0 ms，都在接缝 27.50、52.50、77.50、102.50、142.48、152.50、177.50、192.48 s 处，每一对都是同一段话在接缝两侧各识别了一次（包含关系 6 对，相似度 4 对）。10 对在本次重跑中都有一句被 T-ASRQ-11 去掉（pair_dropped_in_rerun 全为 true），没有误标。
- 本次重跑（run-Gg6ITS）的唯一命中：pv-ja / noisy_music_v1 #59 177.42–181.00 ← #58 173.72–177.42（本记录与 stats 文件的 #n 都是 cues 数组从 0 起的下标；听审页面与 records/T-ASRQ-13.md 写作“第 60 句包含第 59 句”），间隔 0 ms，包含关系（36/19 字）。读过文字：上一句是长拷贝开头的前半，同一段话前半在屏幕上出现两次，这是真实的重复显示，不是误标。它来自 T-ASRQ-11 的远端保护：长拷贝不再被去掉（否则会丢掉约 4 个字），被它覆盖的 0.08 s 片段被去掉，起点从 177.50 移回 177.42，于是与 173.72–177.42 紧挨着。修复前同一位置的命中是 #62 177.50–181.00 ← #61 177.42–177.50（36/13 字），那一对里的片段在本次被去掉了。
- run-SVKkhx → run-Gg6ITS 的标记差异（stats 文件末节，按文字与 3 s 内的时间配对）：少了 5 个 abnormal_rate，多了 1 个 duplicate_neighbor。少掉的 5 个里，4 个是保留句被裁的一端移回后时长恢复正常：pv-zh / quiet 27.09–27.50 → 27.09–28.57 和 102.50–103.60 → 102.25–103.60，pv-zh / noisy 27.10–27.50 → 27.10–28.56，pv-ja / noisy 126.45–127.50 → 126.45–128.11。另 1 个是 pv-ja / noisy 0.08 s 的片段 177.42–177.50，这次被去掉了。移回的 15 句没有新增任何标记。low_confidence 与 repetition_loop 在三次运行上都不变。
- T-ASRQ-11 去掉的 22 句中，有 10 句处在修复前被本规则标出的句对里：8 句本身被标出；2 句是被标句的上一句（pv-zh / quiet_whisper_v1 102.25–102.50 与 pv-ja / noisy_music_v1 177.42–177.50，被标的 102.50–103.60 与 177.50–181.00 在重跑中保留）。其余 12 句不在任何被标出的句对里，原因有三类：一是较短一句不到 5 或 6 字（例如 2 字、4 字的拷贝）；二是拷贝和它重复的那句不紧挨着（终点被裁的拷贝排在保留句前面，或两句之间隔着另一份拷贝）；三是包含关系被一个不同的字打断，相似度又因为长度差不到 0.8。复核规则只是提示，接缝重复主要靠 T-ASRQ-11 去掉。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-12-1 | 通过 | file:records/T-ASRQ-12-unit.txt |
| V-ASRQ-12-2 | 通过 | file:records/T-ASRQ-12-stats.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-14-4 | 通过 | V-ASRQ-12-1, V-ASRQ-12-2 |

## 风险与未执行项

- 真实数据只有 9 段样本，新规则在修复前标出的 10 句全是接缝拷贝，修复后只标出 1 句，也来自接缝。“短语气词不误标”在真实数据上只能说明没有出现误标，规则边界要靠单元测试；其他素材（例如逐字复读的台词）上的误标率没有测过。
- 只和上一句比较。终点被裁到接缝的拷贝排在保留句前面，或两份拷贝之间隔着别的句子时，不会被标出（修复前 22 句接缝拷贝中有 12 句不在任何被标出的句对里）。覆盖率 0.5–0.7 的部分重复（重跑后接缝处还有 8 句）也不会被标。
- pv-ja / noisy_music_v1 177.42–181.00 那一处现在是“同一段话前半出现两次”：去重为了不丢字没有去掉它，只由本规则提示，需要用户在复核栏里手动处理，或在 T-ASRQ-13 听审时确认。
- 副作用：两句只差一位数字的编号句（例如“第 10 句 / 第 11 句”，6 字差 1 字），间隔小于 1 s 时会被相似度规则标出。现有夹具中的这类句子不影响断言。
- 同一个 5 字句完全相同地说两遍不会被标，这是为了保持原来“完全相同至少 6 字”的门槛，需要在 design 中确认。
- AC-ASRQ-14-5（用户听审去重结果）属于 T-ASRQ-13，未完成，由用户听审。
- 未提交。工作树里有其他会话的改动，提交时只加入本任务的文件。
- 2026-10-24 R-ASRQ-14 增加 AC-ASRQ-14-6（修剪保留长句的重复开头，由 T-ASRQ-14 负责）、并补充说明后重新评估任务指纹：本任务的验收项、检查与结论不变。
