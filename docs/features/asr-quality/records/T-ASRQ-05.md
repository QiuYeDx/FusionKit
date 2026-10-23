# 实施记录：T-ASRQ-05

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-05 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`src/subtitle-studio/transcription-review.ts`、`electron/main/subtitle-studio/cue-review.ts`、`src/services/subtitle-studio/cue-review-ignores.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioCueReview.{tsx,css}`、`test/subtitle-studio/transcription-review.test.ts`、`test/subtitle-studio/transcription-review-ipc.test.ts`、`test/subtitle-studio/cue-review-ui.test.ts`。修改：`src/subtitle-studio/ipc-contract.ts`、`electron/main/subtitle-studio/index.ts`（组合文件）、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.css`、`src/services/subtitle-studio/cue-history.ts`、`src/locales/{zh,zh-Hant,en,ja}/studio.json`、`resources/speech-resources/provenance/current-integration-audits.v1.json`（写集外，见“偏离”）、design.md“界面设计基准”中本任务的一条；记录与证据 `records/T-ASRQ-05{.md,-unit.txt,-interface.txt,-ui.txt,-static.txt,-ab-flags.txt}`。评审修正轮改动的是其中的 `cue-review.ts`、`cue-review-ignores.ts`、`StudioCueReview.{tsx,css}`、`StudioCueTable.tsx`、四种语言的 `studio.json`、三个测试文件与 design.md 本任务的一条 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；TypeScript 5.9.3；Electron 41.10.6 + Playwright 1.58.2（静默离屏窗口，隔离的临时 userData，受控转写运行时 + 开发版 FFmpeg 媒体运行时）；没有用 GPU、真实模型或 whisper-server；只读使用 `test-results/asr-quality-ab/run-2512BY` 的 JSON 与 drama 样本音频 |
| 任务指纹 | 0b2d8fa42fedcf22d5c5c4fb6334c58ba36d00e08aeba23c0e6e80d696c84798 |

## 实际结果

实现了复核规则模块、主进程全文档复核查询与 Studio 复核栏（按原因筛选、只列出待复核句子、跳转、播放、重识别、折叠重复、忽略），阈值采用 T-ASRQ-09 的校准值；评审后修正见下文。

### 规则模块（`src/subtitle-studio/transcription-review.ts`）

- 纯函数，不读写文档。导出 `CUE_REVIEW_REASONS`（固定顺序）、`CUE_REVIEW_THRESHOLDS`、`CUE_REVIEW_PHANTOM_PHRASES`、`reviewCue`、`reviewDocument`、`visibleReview`、`reviewPosition`/`reviewStep`（导航）、`collapseRepetition`、`cueReviewIgnoreKey` 与 IPC 请求 schema。评审修正轮没有改这个文件（sha256 `5864ee81…` 不变）。
- 阈值用 records/T-ASRQ-09.md 校准后的值（design 方案 3 规则表已由协调者写回）：low_confidence < 0.55、CJK 过快 > 12 字/秒（其他 30 字符/秒不变）、过慢 ≥ 10 s 且 < 0.8 字/秒；其余规则保持设计值（重复单元 1–10 字 ≥ 4 次且覆盖 ≥ 60%，或 ≥ 20 字且 deflate 压缩比 > 2.4；相邻重复 ≥ 6 字且间隔 < 1 s）。
- 规范化：NFKC → 小写 → 只保留字母、标记、数字；括号注记（()、[]、【】、〔〕）不算说话内容，用于“只有符号或音效”、重复与语速；短语匹配用完整规范化文本。
- 语言：转写稿 `detectedLanguage` → 音轨 `language`（ja/jpn/japanese 等都映射）→ 文档多数字幕的书写系统；每句另按自身书写系统加查一种语言（日语文档里的“Thanks for watching!”也能命中）。
- 短语表（FusionKit 自选，不含单独的おやすみなさい/ありがとう/谢谢大家/Thank you，测试逐条断言）：ja 4 条（ご視聴…ありがとうございま、チャンネル登録、この動画の字幕は、高評価…お願いします）；zh 7 条（字幕由…提供、感谢/谢谢观看收看（含繁体）、请不吝点赞、点赞订阅、订阅我的频道、明镜与点点、字幕志愿者）；en 6 条。
- low_confidence 只在 `sourceRevision === 1` 且转写稿段有 confidence 时成立；拆分/插入的字幕虽与邻句共享段，但一定是已编辑（sourceRevision 2），不会借用置信度。旧文档（转写稿没有 confidence）结果里 `confidence: false`，只按文本规则标记（这是 AC-ASRQ-03-1 中属于本任务的部分）。
- 压缩比的选择：用注入的压缩器。主进程 `electron/main/subtitle-studio/cue-review.ts` 传入 `node:zlib` 的 `deflateSync` 字节数（与 Whisper 的 zlib 压缩比同口径）；不传压缩器时只用重复单元规则（渲染端从不计算规则，只用 `collapseRepetition` 与 `visibleReview`）。
- 结果按文档顺序；每类计数覆盖全文；列出的条目上限 10,000（与查找相同），超出时 `truncated`。

### 主进程查询与 IPC

- `reviewCues({ documentId, revision })`：频道 `subtitle-studio:review-cues`，与 `searchCues` 一样要求窗口已获得该文档、在修订号检查之后执行；只读。preload API 与公开频道策略各加一项。
- `cue-review.ts` 按文档记住最近一次结果（最多 2 个文档）及其测过的每段文字的压缩大小：同一修订再次请求直接返回（接口测试断言为同一对象）；新修订（编辑、翻译提交）只对改过的文字重新 deflate。合成文档实测（`T-ASRQ-05-interface.txt`）：100,000 条首次 1,733 ms，同修订 0 ms，下一修订约 0.7 s；2,000 条首次 54 ms，下一修订约 15 ms。
- `electron/main/subtitle-studio/index.ts` 只加了一个分支与一个导入；按组合审计流程在 `resources/speech-resources/provenance/current-integration-audits.v1.json` 中把 `currentBlobOid` 从 `34da02ec…` 改为 `79d5137d…` 并追加 2026-10-22 原因。该文件在 `scripts/subtitle-studio-provenance/current-composition-audits.json` 中没有条目，因此那边不需要改。评审修正轮没有再改 `index.ts`（blob 仍是 `79d5137d…`），也没有改任何冻结副本或执行器。

### 界面

- 入口：字幕表工具栏“查找”之后的 `ListChecks` 按钮，只对转写（media）文档出现；有标记时显示琥珀色计数（> 999 为 999+），按下态表示复核栏已开。每个修订号请求一次结果；新修订到来前保留上一版结果，避免闪烁。
- 复核栏：占查找栏的表头行（两者互斥），同一外框。计数“第 n / N 条”、“只列出待复核的句子”开关、上一个/下一个（按钮与 Enter/Shift+Enter）、Esc 关闭；原因筛选只列有标记的原因，按实测标签宽度在 `ToolRadioButtonGroup` 与同宽 `Select` 之间切换；当前句一行：编号与原因（Tooltip 给出每条原因的说明与置信度，并注明不是准确率），操作为播放（`CueAudioButton`，无媒体时打开原始媒体面板）、重新识别（打开现有 `StudioCueRecognize`，仅该句）、仅句内重复时的“折叠重复”（Tooltip 预览结果，执行一次普通的原文编辑，撤销标签“折叠 1 条字幕的重复”，英文 “collapse repetition in 1 cue(s)”）、忽略。删除仍只在原有菜单里。旧文档末尾一行说明“没有置信度信息，只按文字规则检查”。
- 只列出被标记的句子（AC-ASRQ-03-3）：复核栏打开时开关默认按下，字幕表只渲染当前原因筛选下被标记的行，其余行不渲染；选择、框选、Ctrl+A、键盘上下移动与删除只经过列出的行，合并、连续播放与时间检查仍按整页的相邻关系判断（不会把隔开的两句当成相邻）。关掉开关回到全部行、保留徽标，用来看上下文；关闭复核栏恢复全部行并清掉原因筛选。改好或忽略的句子不再被标记时离开列表，复核栏接着跳到下一条。没有任何标记时开关禁用、列表不筛选。
- 跨页：页码仍按 100 句分页；上一条/下一条直接跳到被标记句子所在页（Paged.wav 从第 3 句跳到第 205 句，跳过没有标记的第 2 页）；手动翻到没有标记的页时，表体显示一行“这一页没有待复核的句子，可用上一条/下一条转到其他页”。
- 行徽标只在复核栏打开时显示：# 列右缘的 14px 琥珀色图标（第一条原因的图标），Tooltip 列出全部原因；当前项加底色；行高、列宽不变（实测 33px）。
- 忽略：localStorage 键 `fusionkit-studio-review-ignored:<documentId>`，值为 `cueId:sourceRevision` 列表（每文档最多 10,000 条），读写都在 try/catch 中，失败时只在本次会话内有效；文本一改（sourceRevision 变化）标记就会重新出现。有被忽略的标记时复核栏末尾显示“已忽略 N 条标记 · 全部恢复”，点“全部恢复”清除该文档的忽略。
- 渲染审查共修了 8 处界面问题，另有 2 处是测试本身的问题（末行无下边框的高度断言、一步跳开指针后 Tooltip 未关），见 `T-ASRQ-05-ui.txt`。其中表头第二行原先也 `top: 0` 吸顶，列表滚动后会盖住列名与工具栏，查找栏用的是同一行，也一并修好（`--studio-cue-head-row`）；从复核栏打开的重识别对话框按 Esc 时连带关掉复核栏，现在复核栏忽略已被对话框或下拉处理过的 Esc；没有标记时禁用的开关仍显示按下底色，现在只在列表实际被筛选时显示按下。

### 评审后修正（对应评审意见）

- 中：AC-ASRQ-03-3 要求“开启待复核筛选后只列出被标记的句子”，第一轮只计数和跳转、不隐藏行。现在复核栏打开即只列出被标记的句子（见上“只列出被标记的句子”），UI 测试断言 Review.wav 列出 [2, 4, 5, 6, 7, 9, 12, 13]，按原因筛选后为 [5, 12]，Old.wav 为 [2, 4]，无标记文档仍列出全部 4 行，Paged.wav 跨页跳转与空页说明。design.md 本任务的一条已补写这一行为。
- 低（性能）：主进程按（文档，修订）记住结果与压缩大小，数字见上；仍是同步计算，取舍写在“风险与未执行项”。
- 低（1280×800 深色、构建时序）：UI 测试加了 1280×800 深色截图（`run-jyu3m3/11`）；`vite build --mode=test` 在 17:28:27 完成，晚于最后一处渲染端可达的修改（`StudioCueReview.tsx` 17:27:28），记录的运行在其后（17:28:40）。
- 低（撤销标签）：英文改为 “collapse repetition in {count} cue(s)”（i18n 插值变量 count），与相邻标签一致。
- 低（误点忽略无法恢复）：加了“全部恢复”，UI 测试覆盖重开后恢复。

### 真实 A/B 输出上的标记数（只读，供 T-ASRQ-09）

用本模块（校准后阈值 + zlib）对 `run-2512BY` 的 27 个 JSON 统计，详表与逐条清单见 `T-ASRQ-05-ab-flags.txt`（规则模块本轮未改，结果不变）：

| 变体 | 字幕 | 被标记 | low_confidence | phantom_phrase | repetition_loop | non_speech_only | abnormal_rate | duplicate_neighbor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| standard | 363 | 17 | 10 | 0 | 1 | 0 | 6 | 0 |
| quiet_whisper_v1 | 351 | 24 | 14 | 0 | 1 | 0 | 11 | 0 |
| noisy_music_v1 | 336 | 15 | 6 | 0 | 1 | 0 | 9 | 0 |

与 T-ASRQ-09 用近似脚本按建议值得到的合计（17 / 24 / 15）一致。B-noise 的 quiet 幻觉「しゅりゅくぷ…」命中 low_confidence + repetition_loop；noisy 的「しっかりと、うらやまして」（0.876）任何规则都不命中，与 T-ASRQ-09 的结论相同。

### 偏离

- 写集外：`resources/speech-resources/provenance/current-integration-audits.v1.json`（改组合文件 `index.ts` 后必须重新登记，任务说明要求）。
- design“界面设计基准·复核栏”写的是查找栏式的工具栏；为满足 AC-ASRQ-03-3，在本任务的参照测量一条里补写了“只列出待复核的句子”开关、列表筛选、空页说明与“全部恢复”。
- 复核只对转写（media）文档提供；导入的字幕文档不显示入口（主进程查询本身对任何文档都可用）。这样不使用转写的用户看不到任何变化。
- 行徽标只在复核栏打开时显示，默认列表外观不变（design 没有规定常驻与否）。
- `StudioCueFind.css` 的吸顶修正同时改变查找栏（之前滚动后会盖住列名）；查找栏既有 UI 测试已复跑通过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-05-1 | 通过 | file:records/T-ASRQ-05-unit.txt |
| V-ASRQ-05-2 | 通过 | file:records/T-ASRQ-05-interface.txt |
| V-ASRQ-05-3 | 通过 | file:records/T-ASRQ-05-ui.txt |
| V-ASRQ-05-4 | 通过 | file:records/T-ASRQ-05-static.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-03-2 | 通过 | V-ASRQ-05-1 |
| AC-ASRQ-03-3 | 通过 | V-ASRQ-05-2, V-ASRQ-05-3 |
| AC-ASRQ-03-4 | 通过 | V-ASRQ-05-1, V-ASRQ-05-2, V-ASRQ-05-3 |
| AC-ASRQ-03-5 | 通过 | V-ASRQ-05-1, V-ASRQ-05-2, V-ASRQ-05-3 |

## 风险与未执行项

- 只列出被标记的句子是在当前 100 句的页内筛选：页脚分页器仍按全文分页，手动翻页会经过没有标记的页（显示一行说明），只有上一条/下一条会跳过它们；列表开关默认按下是本任务按 AC 文字所做的选择，用户若更习惯在全部行中复核，可在验收时提出改为默认关闭。
- 打开复核栏时切到另一份文档，在该文档的复核结果返回前（一般几十毫秒）列表短暂显示全部行，结果到达后才筛选。
- 性能：主进程同步计算，没有放进 worker。已按（文档，修订）记住结果与压缩大小：同修订重复请求不再计算；新修订在 100,000 条（LIMITS.cues 上限）时仍约 0.7 s、2,000 条约 15 ms，首次打开分别约 1.7 s 与 54 ms。只对转写文档计算，不用转写的用户不受影响；极大的转写文档在每次编辑或翻译提交后仍会让主进程停顿约 0.7 s，作为已知取舍接受。
- “全部恢复”一次恢复该文档的所有忽略，没有逐条恢复或已忽略列表。
- 阈值只按 large-v3 的一次对照校准（T-ASRQ-09）；换模型（如 turbo）置信度分布不同，可能需要另定阈值。置信度只是模型把握程度，高置信度的错词（T-ASRQ-09 中 0.75–0.97 的替换、B-noise 的 0.876 幻觉）复核栏看不到，不能代替听审。
- 编辑后再撤销，文本虽恢复，sourceRevision 仍大于 1，因此 low_confidence 不会回来（文本规则会）；这是按“未编辑 = sourceRevision 1”的规定实现的结果。
- 现有重识别对话框打开时焦点仍留在打开它的按钮上（对话框原有行为，本任务未改）；Esc 关闭对话框不再连带关闭复核栏，但键盘用户需要 Tab 才进入对话框。
- 以 `FUSIONKIT_STUDIO_E2E=1` 门控的 Studio UI 测试文件共 32 个（含本任务新增的 1 个），只复跑了与本改动相关的 9 个（复核、查找、重识别、原声播放、听校、平移、拆分插入、编辑、撤销历史），全部通过；其余 23 个未运行。真实转写文档的界面检查用的是 run-2512BY 的 drama.standard 转写结果与原始样本音频（7 条标记），不是在应用里新转写的文档。
- `check-i18n-usage` 的 40 条既有错误与本任务开始前（同一工作树）逐条相同，没有对 HEAD 导出副本复核。
- 未提交；`current-integration-audits.v1.json` 的条目必须与 `index.ts` 一起提交。
