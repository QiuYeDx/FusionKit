# 长文本翻译（重写）任务

每个任务块是唯一任务台账。需求见 [requirements.md](requirements.md)，设计见 [design.md](design.md)（下文“设计 §x”）。

## 并行编排

写集互不重叠的任务可以由不同工程师同时进行；同一波内的任务互不依赖。

| 波次 | 任务（可并行） | 前置 |
|---|---|---|
| W1 | T-LT-01 删除旧工具；T-LT-02 共享契约 | — |
| W2 | T-LT-03 分段与分页；T-LT-04 行内保护与协议；T-LT-06 日志回放；T-LT-07 编码识别；T-LT-13 渲染端客户端与 store；T-LT-14 文案与标签映射 | T-LT-02 |
| W3 | T-LT-05 质量检查与导出组装；T-LT-08 仓库与内存文档 | W2 中各自的前置 |
| W4 | T-LT-09 导入器与旧目录清理；T-LT-10 运行器；T-LT-11 导出器 | W3 |
| W5 | T-LT-12 服务、IPC、预加载与接线 | T-LT-09、10、11 |
| W6 | T-LT-15 页面骨架、文档库、导入与提示 | T-LT-12、13、14 |
| W7 | T-LT-16 阅读器；T-LT-17 对话框 | T-LT-15 |
| W8 | T-LT-18 Agent 页面上下文（可选）；T-LT-19 Electron UI 测试与回归 | T-LT-16、17 |
| W9 | T-LT-20 文档、发布说明与最终审计 | T-LT-19 |

**共用约定**

- 提交用临时 `GIT_INDEX_FILE`，提交后 `git show --stat` 检查（主检出与其他会话共享索引）；绝不读写主检出 `C:\Users\Administrator\Documents\GitHub\FusionKit` 中 `.claude\worktrees` 以外的文件。
- 不改 `package.json`、`pnpm-lock.yaml`、Studio 目录、`electron/main/ai/*`、`electron/main/local-subtitle/*`、`studio.json`。
- 每个任务完成前跑 `pnpm exec tsc --noEmit` 与本任务的单元测试；Electron 测试前先 `pnpm run pretest`；结束后只结束本 worktree 下的 `electron.exe`。
- 文案键只由 T-LT-14 写入；UI 任务需要新键时在任务记录里列出，由 T-LT-14 负责人合并（或在 T-LT-19 统一补齐）。
- `index.tsx` 只由 T-LT-15 写入；T-LT-15 为 T-LT-16 / 17 的组件建好**最终签名的桩文件**（返回最小可用标记），T-LT-16 / 17 只替换这些文件的实现，不改 `index.tsx`。

---

### T-LT-01 删除旧工具（M0 收尾）

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22，主会话） |
| 批次 | I1 |
| 需求 | R-LT-01 |
| 验收 | AC-LT-01-1, AC-LT-01-2, AC-LT-01-3, AC-LT-01-5 |
| 依赖 | - |
| 写集 | electron/main/index.ts, src/App.tsx, src/lib/legacy-storage-cleanup.ts, scripts/i18n-usage-manifest.mjs, src/locales/{zh,en,ja,zh-Hant}/text.json, src/pages/Tools/Text/LongTextTranslator/index.tsx（占位）, 以及删除清单中的全部旧文件 |

#### 结果

旧文件已全部删除（56 个），`electron/main/index.ts` 去掉两处导入、`TextTranslationService` 构造与 `setupTextTranslationIPC`；`App.tsx` 改为导入 `LongTextTranslator`（占位 `return null`）；i18n 清单删除旧选择器；`legacy-storage-cleanup` 加入 `fusionkit-text-translator`；四个 `text.json` 为 `{}`；`tsc --noEmit` 通过。

**裁决（覆盖设计 §0.3 E1）**：`electron/main/ai/openai-compatible-client.ts` 唯一的引用者是旧测试，删除后成为死文件，**保持删除**（不在边界清单与溯源基线中，`check-boundaries` 通过）。旧工具专用依赖（`chardet`、`remark-frontmatter`、`remark-parse`、`unified`、`@types/mdast`）的移除由主会话在 T-LT-20 之后单独处理；其余任务仍不改 `package.json` / 锁文件。两份审计 JSON 的 `currentBlobOid` 由 T-LT-12 按最终字节一次性更新。

已知中间状态：占位页没有 `h1`，`tool-spacing` / `tool-navigation` / `tool-file-drop` 的 `text/translator` 用例在 T-LT-15 前为红，属预期（这三个文件在 HEAD 基线上已因其他原因为红）。

### T-LT-02 共享契约、通道与语言工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-07, R-LT-20 |
| 验收 | AC-LT-07-1, AC-LT-07-3, AC-LT-20-5 |
| 依赖 | - |
| 写集 | src/long-text/channels.ts, src/long-text/contract.ts, src/long-text/model.ts, src/long-text/languages.ts, src/long-text/text-stats.ts, test/long-text/contract.test.ts, test/long-text/languages.test.ts, test/long-text/text-stats.test.ts |

#### 结果

V-LT-02-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/contract.test.ts test/long-text/languages.test.ts test/long-text/text-stats.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。V-LT-02-2 通过：`pnpm exec tsc --noEmit`；`rg -n "from '@/" src/long-text` 无匹配。

#### 实现要点

按设计 §5.1–5.4、§5.6 的类型与 schema 原样落地：`channels.ts` 只依赖 zod；`contract.ts` 运行时只依赖 zod、`./channels`、`../translation-knowledge/execution-contract`，类型引用 `../lib/model-error-category`；全部相对路径导入。`model.ts` 定义设计 §6.4.2、§6.10 的内部类型（`SegmentRecord`、`SegmentTable`、`TranslationRecord`、`InlineMark`、`JournalLine`、`DocumentManifest`、`RunRecord`）。`languages.ts` 按设计 §6.6（含简繁特有字对与拉丁停用词）；`text-stats.ts` 的 `estimateTokens`、`joinerBetween`、书写系统分类。`model.ts` 还定义运行器与内存文档之间的 `DocumentPort` 接口：`candidates(page, filter)`、`markInFlight(indices)` / `releaseInFlight(indices)`、`rev(index)`、`displayAt(index)`、`translationAt(index)`、`commit(records, usageLine)`、`clear(indices)`、`pageOf(index)`、`pagesWithCandidates(scope)`、`emit(range)`（T-LT-08 实现、T-LT-10 使用）。其他任务只消费这些类型，需要改动时由本任务负责人合并。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-02-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/contract.test.ts test/long-text/languages.test.ts test/long-text/text-stats.test.ts`：schema 正反例、`settingsSchema` 拒绝 `source:''` 的资料、endpoint 规则、`indexSchema` 上限 199,999、`changeEventSchema` 过滤、语言识别 10 种、`defaultTarget` 回退、`estimateTokens` 对照 `gpt-tokenizer` ±30% | - |
| V-LT-02-2 | static | required | `pnpm exec tsc --noEmit`；`rg -n "from '@/" src/long-text` 无匹配 | - |

### T-LT-03 分段与分页

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-05 |
| 验收 | AC-LT-05-1, AC-LT-05-2, AC-LT-05-3, AC-LT-05-4, AC-LT-05-5(a)(b), AC-LT-05-6, AC-LT-05-7 |
| 依赖 | T-LT-02 |
| 写集 | src/long-text/segments.ts, src/long-text/segment-txt.ts, src/long-text/segment-markdown.ts, src/long-text/pages.ts, test/long-text/segment-txt.test.ts, test/long-text/segment-markdown.test.ts, test/long-text/pages.test.ts, test/long-text/fixtures/*.txt, test/long-text/fixtures/*.md |

#### 结果

V-LT-03-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/segment-txt.test.ts test/long-text/segment-markdown.test.ts test/long-text/pages.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.3、§6.4.1–6.4.2、§6.4.4、§6.5：`segmentDocument(format, S, { txtSplit, inlineSpans })` 返回 `{ records, table, pages, structure, detectedStyle }`，以异步迭代器形式每 2,000 行让出；`displaySource`；超长段拆分。Markdown 超长段的安全切点与“行内记号 > 200”判定需要行内记号区间，由调用方注入 `inlineSpans(display, kind, format): Array<[start, end]>`（生产中由 T-LT-09 的导入器传入 T-LT-04 的 `findInlineSpans`），本任务不导入 `inline.ts`，测试用只识别代码 span 与链接的桩函数。另导出 `loadSegmentTable(lines: AsyncIterable<string>)` 供仓库加载 `segments.jsonl`。夹具：小说缩进 TXT、古腾堡折行 TXT、诗歌 TXT、综合 Markdown（约 300 行，含设计 §6.4.1 表中全部块类型）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-03-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/segment-txt.test.ts test/long-text/segment-markdown.test.ts test/long-text/pages.test.ts`：每个用例断言不变式 (a)(b)；line / unwrap 判定；章节与分隔；200,000 段上限；分页规则 | - |

### T-LT-04 行内保护与批量协议

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-12 |
| 验收 | AC-LT-05-5(c), AC-LT-12-1, AC-LT-12-3, AC-LT-12-6 |
| 依赖 | T-LT-02 |
| 写集 | src/long-text/inline.ts, src/long-text/protocol.ts, test/long-text/inline.test.ts, test/long-text/protocol.test.ts |

#### 结果

V-LT-04-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/inline.test.ts test/long-text/protocol.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.4.3（14 级记号表、`decode` 11 步流程、非最后一次 / 最后一次的区别、sep 按位置处理、link 缺失时追加 open + inner + close、修复预算、块语法转义、`markupRaws`）与 §6.7.2（宽松解析：忽略未知顶层键与项内未知键；`terms` 侧信道永不失败）。同时实现 T-LT-03 需要的 `findInlineSpans`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-04-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/inline.test.ts test/long-text/protocol.test.ts`：每种记号投影；不变式 (c)；修复各分支；`notes` 等未知键被忽略；ids 不符为批级错误 | - |

### T-LT-05 质量检查与导出组装

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-16, R-LT-17 |
| 验收 | AC-LT-16-1, AC-LT-16-2, AC-LT-16-3, AC-LT-17-2, AC-LT-17-3, AC-LT-17-7, AC-LT-05-5(a), AC-LT-05-7 |
| 依赖 | T-LT-03, T-LT-04 |
| 写集 | src/long-text/quality.ts, src/long-text/rebuild.ts, test/long-text/quality.test.ts, test/long-text/rebuild.test.ts, test/long-text/fixtures/*.expected.* |

#### 结果

V-LT-05-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/quality.test.ts test/long-text/rebuild.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §7（`checkModelOutput`、`checkUserEdit`、`RatioReference` 冷启动表与 30 样本切换、计数口径）与 §6.12（仅译文的 `\n` 映射、双语规则表、组合并、表格单元格数不一致回退、ATX 双语单行）。黄金文件覆盖 TXT line / unwrap / 拆分组 / CRLF 与 MD 全部类型。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-05-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/quality.test.ts test/long-text/rebuild.test.ts` | - |

### T-LT-06 日志回放

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-10, R-LT-18 |
| 验收 | AC-LT-10-3, AC-LT-18-1 |
| 依赖 | T-LT-02 |
| 写集 | src/long-text/journal.ts, test/long-text/journal.test.ts |

#### 结果

V-LT-06-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/journal.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.10“日志行”：`t:'s'` 完整段状态、`t:'u'` 用量增量的 zod schema；`encodeRecord` / `decodeRecord`；纯函数 `replayJournal(snapshot, lines) → { records, usage, runUsage, lastSeq, skipped }`（同一段取 q 最大者、只应用 q > snapshot.seq、坏行计数）；`buildSnapshot(state)`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-06-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/journal.test.ts`：性质测试（随机 200 次操作序列，“快照 + 回放” ≡ “全量回放”，至少 50 个随机种子）；用量求和；坏行跳过 | - |

### T-LT-07 编码识别

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-04 |
| 验收 | AC-LT-04-1 |
| 依赖 | T-LT-02 |
| 写集 | electron/main/long-text/encoding.ts, electron/main/long-text/encoding-tables.ts, test/long-text/encoding.test.ts |

#### 结果

V-LT-07-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/encoding.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.2：BOM、无 BOM UTF-16、严格 UTF-8、NUL 二进制检测、候选样本对齐、有效性门槛（无 U+FFFD、无 C0/C1、iconv 往返逐字节相同）、Big5/GBK 尾字节启发、假名 / 谚文加分、字频分、high / low 判定、无有效候选时的回退、控制符比例；`decodeBytes`；`previewLines(bytes, encoding)`（前 8 个非空行、每行 200 字、替换字符计数）。常用字表各约 500 字。只用 iconv-lite。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-07-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/encoding.test.ts`：样本由 `iconv.encode` 现场生成，不放二进制夹具 | - |

### T-LT-08 仓库与内存文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-06, R-LT-10, R-LT-16 |
| 验收 | AC-LT-06-2, AC-LT-06-5, AC-LT-10-3, AC-LT-16-4, AC-LT-16-6, AC-LT-16-7 |
| 依赖 | T-LT-03, T-LT-06 |
| 写集 | electron/main/long-text/repository.ts, electron/main/long-text/document-state.ts, test/long-text/repository.test.ts, test/long-text/document-state.test.ts |

#### 结果

V-LT-08-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/repository.test.ts test/long-text/document-state.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

`repository.ts` 按设计 §6.10：目录布局、每文档串行写队列、追加（open-a / write / datasync / close）、manifest tmp → fsync → copy prev → rename（EPERM / EBUSY 重试）、快照压缩两步、`index.json` 去抖与重建、`.staging-*` / `.trash-*`、加载流程（prev 回退、`damaged` / `newer_version`、残行截断、坏行计数）、存储占用（10 秒缓存）。`document-state.ts`：`LoadedDocument`（S、`SegmentTable`、译文数组、计数、页统计、`inFlight` 集合、rev）、`readPage`、`query`（四种筛选 + 查找：NFKC、小写、5,000 截断、懒建索引）、`locate`（环绕、锁定段规则）、`summary()` / `detail()`；实现 T-LT-02 定义的 `DocumentPort`（提交走串行写队列，一次追加多行 + 用量行）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-08-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/repository.test.ts test/long-text/document-state.test.ts`：临时目录（`fs.mkdtemp(os.tmpdir())`，`fs.rm` 带 `maxRetries`）；压缩崩溃窗口；回退与损坏；筛选、查找、定位 | - |

### T-LT-09 导入器与旧目录清理

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-01, R-LT-02, R-LT-03, R-LT-04, R-LT-05 |
| 验收 | AC-LT-01-4, AC-LT-02-3, AC-LT-02-4, AC-LT-02-5, AC-LT-03-2, AC-LT-04-3, AC-LT-05-8, AC-LT-07-1 |
| 依赖 | T-LT-03, T-LT-04, T-LT-07, T-LT-08 |
| 写集 | electron/main/long-text/importer.ts, electron/main/long-text/legacy-cleanup.ts, test/long-text/importer.test.ts, test/long-text/legacy-cleanup.test.ts |

#### 结果

V-LT-09-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/importer.test.ts test/long-text/legacy-cleanup.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

`importer.ts`：调用 `segmentDocument` 时注入 `inlineSpans: findInlineSpans`（来自 `src/long-text/inline.ts`）；`importFiles(paths, source, defaults)` 与 `importText(name, text, format, defaults)`——`lstat` 与扩展名先于读取、10 MiB 上限、字幕与不支持扩展名、sha256 去重、编码识别、分段、分页、默认设置合成（`defaultTarget` 同语言回退、文体建议、资料集按方向与归档过滤，资料库通过注入的 `readKnowledge` 读取，读不到时丢弃资料集）、写 staging 后 rename；`resegment(doc, { encoding?, txtSplit? })` 用 `original.bin` 重新解码与分段。`legacy-cleanup.ts` 按设计 §6.14。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-09-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/importer.test.ts test/long-text/legacy-cleanup.test.ts`：拒绝原因、去重、默认设置、junction（`fs.symlink(dir, link, 'junction')`）；性能（5 MB TXT / MD < 5 s，`monitorEventLoopDelay` 最大值 < 250 ms） | - |

### T-LT-10 运行器

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-08, R-LT-09, R-LT-10, R-LT-11, R-LT-12, R-LT-13, R-LT-15, R-LT-18 |
| 验收 | AC-LT-08-1, AC-LT-08-2, AC-LT-08-3, AC-LT-09-1, AC-LT-09-2, AC-LT-09-5, AC-LT-09-7, AC-LT-10-1, AC-LT-10-2, AC-LT-11-1, AC-LT-11-2, AC-LT-11-3, AC-LT-11-4, AC-LT-11-6, AC-LT-12-2, AC-LT-12-3, AC-LT-12-4, AC-LT-12-5, AC-LT-12-7, AC-LT-13-1, AC-LT-13-2, AC-LT-13-3, AC-LT-13-5, AC-LT-13-6, AC-LT-15-6, AC-LT-15-7, AC-LT-18-2, AC-LT-07-8 |
| 依赖 | T-LT-04, T-LT-05, T-LT-08 |
| 写集 | electron/main/long-text/runner.ts, electron/main/long-text/planner.ts, electron/main/long-text/prompt.ts, electron/main/long-text/request-pool.ts, electron/main/long-text/knowledge.ts, electron/main/long-text/ledger.ts, test/long-text/runner.test.ts, test/long-text/retranslate.test.ts, test/long-text/planner.test.ts |

#### 结果

V-LT-10-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/runner.test.ts test/long-text/retranslate.test.ts test/long-text/planner.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.7–6.9：

- `prompt.ts`：系统提示词（逐字使用设计 §6.7.1 文本与三种 STYLE）与载荷构造。
- `planner.ts`：`nextUnit`、三个预算、family 预算、`requestTokenEstimate`（只读导入 `../ai/adapters/chat-completions-adapter` 的 `buildChatCompletionBody` 与 `../ai/adapters/responses-adapter` 的 `buildResponsesBody`；不导入 Studio 文件）、削减顺序、`estimate()`（模型基准与观测基准）。
- `request-pool.ts`：FIFO 6 槽、可中止等待、交互优先且交互最多 2（形状参照 Studio `TranslationScheduler`，自写）。
- `runner.ts`：`Run`（路与页队列、派发、§6.8.4 结果处理表全部分支、单段才计尝试、deferred、JSON 降级、限流降路与恢复、致命错误、不稳定守卫、平缓 / 立即暂停、ETA、用量行）、`RetranslateJob`（在途占用、rev 复核、交互优先级、致命错误只影响本次）。`send` 通过构造参数注入。
- `knowledge.ts`、`ledger.ts`：设计 §6.9.4–6.9.5。

运行器只依赖 T-LT-02 定义的 `DocumentPort` 接口（T-LT-08 实现），测试中用内存实现，不修改 `document-state.ts`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-10-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/runner.test.ts test/long-text/retranslate.test.ts test/long-text/planner.test.ts`：注入 `send` + `vi.useFakeTimers` + 临时目录，覆盖设计 §9.1 中 runner / retranslate / planner 三行列出的全部情形 | - |

### T-LT-11 导出器

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-17 |
| 验收 | AC-LT-17-1, AC-LT-17-4, AC-LT-17-5, AC-LT-17-6, AC-LT-17-7 |
| 依赖 | T-LT-05, T-LT-08 |
| 写集 | electron/main/long-text/exporter.ts, test/long-text/exporter.test.ts |

#### 结果

V-LT-11-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/exporter.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。

#### 实现要点

按设计 §6.12“写出”：文件名规则与清洗、目录解析（源目录 / `exportFolder` / `app.getPath('documents')`，经注入的 `paths` 函数）、临时文件 + `link` 不覆盖发布、`(2)…(99)`、`EPERM`/`ENOTSUP`/`EOPNOTSUPP`/`EXDEV`/`ENOSYS`/`EISDIR`/`EINVAL` 改 `wx`、与源路径比较（win32 / darwin 不区分大小写）、错误映射、导出记录、`reveal` 白名单、`copy`（注入 `clipboard`）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-11-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/exporter.test.ts` | - |

### T-LT-12 服务、IPC、预加载与接线

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-02, R-LT-06, R-LT-09, R-LT-10, R-LT-20 |
| 验收 | AC-LT-06-3, AC-LT-09-6, AC-LT-10-4, AC-LT-20-1, AC-LT-20-2, AC-LT-20-3, AC-LT-20-4 |
| 依赖 | T-LT-09, T-LT-10, T-LT-11 |
| 写集 | electron/main/long-text/service.ts, electron/main/long-text/ipc.ts, electron/main/long-text/index.ts, electron/preload/long-text-api.ts, electron/preload/long-text-channel-policy.ts, electron/preload/index.ts, electron/main/index.ts, src/vite-env.d.ts, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json, test/long-text/service.test.ts, test/long-text/ipc.test.ts, test/long-text/composition.test.ts |

#### 结果

V-LT-12-1 通过：`node node_modules/vitest/vitest.mjs run test/long-text/service.test.ts test/long-text/ipc.test.ts test/long-text/composition.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。V-LT-12-2：`pnpm exec tsc --noEmit` 通过；`pnpm run pretest` 未运行（留给回归步骤）。V-LT-12-3：`shared-resource-integration.mjs`、`copy.mjs --check`、`generate.mjs --check`、`check-boundaries.mjs` 与 `node node_modules/vitest/vitest.mjs run test/windowChrome.test.ts test/local-subtitle/overwriteProductionRuntime.test.ts test/model-setup/ipc.test.ts`（16 项）通过（2026-10-23）；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance` 未运行（含启动子进程的回放用例，留给回归步骤）。

#### 实现要点

- `service.ts`：设计 §5.3 全部命令；文档 LRU（3，运行中固定）；`busy` / `conflict` / `revision_conflict` 语义；删除时先中止；事件序号与 120ms 合并；`settingsDigest`；`knowledge.languagePair` 覆盖；`updateSettings` 的语言变更清除。
- `ipc.ts` / `index.ts`：设计 §6.1（`ready`、受信 `isTrustedAppSender(event) && event.sender === getWindow()?.webContents`、Result 映射、`before-quit` 同步中止、`dispose`）。
- 预加载：设计 §5.6；`long-text-api.ts` 运行时只导入 `src/long-text/channels.ts`。
- `electron/main/index.ts` 与 `electron/preload/index.ts`：严格按设计 §8.2-2、§8.2-3 的最小修改；不动测试检索的字符串与 `runtimes` 列表。
- `src/vite-env.d.ts`：设计 §8.2-4。
- 两份审计 JSON 按最终字节重算 `currentBlobOid` 并追加 reason（设计 §8.2-5）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-12-1 | unit | required | `node node_modules/vitest/vitest.mjs run test/long-text/service.test.ts test/long-text/ipc.test.ts test/long-text/composition.test.ts` | - |
| V-LT-12-2 | interface | required | `pnpm exec tsc --noEmit`；`pnpm run pretest`（含 `check-preload-bundle`） | - |
| V-LT-12-3 | interface | required | `node scripts/subtitle-studio-provenance/shared-resource-integration.mjs`；`node scripts/subtitle-studio-provenance/copy.mjs --check`；`node scripts/subtitle-studio-provenance/generate.mjs --check`；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`；`node scripts/subtitle-studio/check-boundaries.mjs`；`node node_modules/vitest/vitest.mjs run test/windowChrome.test.ts test/local-subtitle/overwriteProductionRuntime.test.ts test/model-setup/ipc.test.ts` | - |

### T-LT-13 渲染端客户端与 store

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-07, R-LT-10 |
| 验收 | AC-LT-07-1, AC-LT-10-4 |
| 依赖 | T-LT-02 |
| 写集 | src/services/long-text/client.ts, src/services/long-text/model.ts, src/services/long-text/model.test.ts, src/store/tools/text/useLongTextStore.ts, src/store/tools/text/useLongTextStore.test.ts |

#### 结果

V-LT-13-1 通过：`node node_modules/vitest/vitest.mjs run src/services/long-text/client.test.ts src/services/long-text/model.test.ts src/store/tools/text/useLongTextStore.test.ts`（2026-10-23，与其余非 Electron 文件同批点名运行；审查修复期间复核：32 个文件、727 项通过、1 项跳过——`exporter.test.ts` 中只在非 Windows 运行的文件权限用例）。这三个文件即两个目录下的全部测试。

#### 实现要点

按设计 §5.7：`unwrap` 与 `LongTextClientError`；`resolveRunModel`（五种结果、DeepSeek thinking、`maxOutputTokens` 压到上下文一半、回退任务模型）、`costRange`、`emptyMaterials`；`useLongTextStore`（键 `fusionkit-long-text`，version 1，`sanitizeLongTextState` 在 `migrate` 与 `merge` 中执行，`pageByDocument` LRU 50，不存密钥与文档内容）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-13-1 | unit | required | `node node_modules/vitest/vitest.mjs run src/services/long-text src/store/tools/text`（`vi.hoisted` localStorage 垫片） | - |

### T-LT-14 文案与标签映射

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-19 |
| 验收 | AC-LT-19-6 |
| 依赖 | T-LT-02 |
| 写集 | src/locales/{zh,en,ja,zh-Hant}/text.json, src/locales/{zh,en,ja,zh-Hant}/tools.json（只改 `field_desc.text_translator` 与 `sub_desc.text_tools` 的值）, src/pages/Tools/Text/LongTextTranslator/labels.ts |

#### 结果

V-LT-14-1 通过：`node scripts/check-i18n.mjs`；`pnpm exec tsc --noEmit`（2026-10-23）。`test/long-text/labels.test.ts` 同批通过。

#### 实现要点

按设计 §8.4 的键树写入四种语言（zh 为准，en / ja / zh-Hant 逐条翻译，键集合完全一致，无空值）；语气按设计 §4.10。`labels.ts`：错误码、提示码、失败码、运行状态、编码名、文体、筛选、修复类别 → 文案键的 `as const` 映射，键类型为有限联合，保证 `check-i18n-usage` 能穷举（不加 manifest 条目）。本阶段尚无代码引用这些键，`--unused=text` 留到 T-LT-19 检查。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-14-1 | interface | required | `node scripts/check-i18n.mjs`；`pnpm exec tsc --noEmit` | - |

### T-LT-15 页面骨架、文档库、导入与提示

| 字段 | 值 |
| --- | --- |
| 状态 | 实现完成；V-LT-15-2（Electron UI）与 V-LT-15-3 / 16-2 / 17-2（视觉）未运行——需用户同意后以安静窗口运行 |
| 批次 | I1 |
| 需求 | R-LT-02, R-LT-03, R-LT-06, R-LT-09, R-LT-11, R-LT-19 |
| 验收 | AC-LT-02-1, AC-LT-02-2, AC-LT-03-1, AC-LT-03-3, AC-LT-03-4, AC-LT-06-1, AC-LT-06-4, AC-LT-06-6, AC-LT-09-6, AC-LT-11-2, AC-LT-11-5, AC-LT-19-1, AC-LT-19-3, AC-LT-19-7 |
| 依赖 | T-LT-12, T-LT-13, T-LT-14 |
| 写集 | src/pages/Tools/Text/LongTextTranslator/{index.tsx, page-context.tsx, long-text.css, DocumentLibrary.tsx, LibraryDialog.tsx, MobileControls.tsx, StartPanel.tsx, Notices.tsx, PasteDialog.tsx, LiveRegion.tsx}, src/pages/Tools/Text/LongTextTranslator/hooks/{useDocuments.ts, useDocumentDetail.ts, usePageShortcuts.ts}, 以及 T-LT-16 / 17 组件的桩文件（reader/*.tsx、dialogs/*.tsx 首版） |

#### 结果

V-LT-15-1：`pnpm exec tsc --noEmit` 通过；`node node_modules/vitest/vitest.mjs run src/pages/Tools/_shared/ui` 中 5 个文件通过，`ToolFileDropZone.test.ts` 与 `ToolSwitchRow.test.tsx` 在本 worktree 无法加载（`node_modules` 解析不到 `react-remove-scroll`，两文件本次未改动）（2026-10-23）。`test/long-text/page-shell.test.ts` 同批通过。

#### 实现要点

- 按设计 §3.1 骨架、§3.2 同构、§3.3-A / §3.4 N-A 与 N-G 线框、§3.6 `long-text.css`：全高布局、320px 文档面板（搜索 > 6 篇、37px 存储页脚、4px 运行进度条）、窄窗控件行与 540 宽文档列表对话框、空状态（`ToolFilePickerSurface stacked`，窄窗 horizontal）、唯一整页拖放目标（`resolveSelectedNativeFiles` 同步捕获）、粘贴对话框（自动识别 Markdown）、页面 Ctrl+V 与 Ctrl+F、提示条栈（设计 §4.8，含致命错误条与 `ModelErrorGuide context="runtime"`）、`LiveRegion`、离开页面 toast、`ToolPageHeader` 描述末尾“翻译资料”链接。
- `page-context.tsx` 定义 `LongTextPageContext`（当前文档详情、命令、对话框开关、`announce`），并为 T-LT-16 / 17 的每个组件写好**最终签名**的桩文件。
- 只读导入 `StudioFileName`、`StudioIconButton`、`StudioNotice`、`StudioScrollFade`（理由见设计 §3.1）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-15-1 | static | required | `pnpm exec tsc --noEmit`；`node node_modules/vitest/vitest.mjs run src/pages/Tools/_shared/ui`（Checkbox 白名单、variant 三元禁令） | - |
| V-LT-15-2 | ui | required | `pnpm run pretest`；`$env:FUSIONKIT_TOOL_UI_E2E='1'; pnpm exec vitest run test/tool-spacing.electron.test.ts test/tool-navigation.electron.test.ts test/tool-file-drop.electron.test.ts`，与 HEAD 基线比较（已知基线红项除外） | - |
| V-LT-15-3 | visual | required | 1280×860、786×660、786×540，深浅主题：空状态、文档列表（长文件名 Tooltip、选中与悬停相邻）、窄窗控件行、提示条栈、粘贴对话框；按 `fusionkit-ui-design` 自查顺序 | - |

### T-LT-16 阅读器

| 字段 | 值 |
| --- | --- |
| 状态 | 实现完成；V-LT-15-2（Electron UI）与 V-LT-15-3 / 16-2 / 17-2（视觉）未运行——需用户同意后以安静窗口运行 |
| 批次 | I1 |
| 需求 | R-LT-09, R-LT-14, R-LT-15, R-LT-16, R-LT-19 |
| 验收 | AC-LT-07-5, AC-LT-09-3, AC-LT-09-4, AC-LT-14-1, AC-LT-14-2, AC-LT-14-3, AC-LT-14-4, AC-LT-14-5, AC-LT-14-6, AC-LT-15-1, AC-LT-15-2, AC-LT-15-3, AC-LT-15-4, AC-LT-15-5, AC-LT-15-8, AC-LT-16-5, AC-LT-16-6, AC-LT-16-7, AC-LT-16-8, AC-LT-19-2 |
| 依赖 | T-LT-15 |
| 写集 | src/pages/Tools/Text/LongTextTranslator/reader/{ReaderPanel.tsx, ReaderHeader.tsx, ReaderToolbar.tsx, RunControls.tsx, ReaderList.tsx, ReaderRow.tsx, InlineText.tsx, RowMenu.tsx, RowEditor.tsx, RetranslatePopover.tsx, ReaderFooter.tsx, PageStrip.tsx, PagePicker.tsx, useReaderPage.ts, useFollowProgress.ts, useReaderKeyboard.ts, reader.css} |

#### 结果

V-LT-16-1：同 T-LT-15 结果（tsc 通过；`_shared/ui` 5 / 7 个文件通过，2 个因依赖解析无法加载）。`test/long-text/reader.test.ts` 同批通过。

#### 实现要点

按设计 §3.3-B / C / D、§3.4 N-B / N-C / N-D、§3.6 `reader.css` 与规格表、§4.1–4.7、§4.9、§5.2.3：两行标题 + 头部三个图标（导出、译名表、⋯ 菜单含“仅显示译文”）；工具栏左侧 `ClipPathTabs` 筛选 + 需关注 ↑↓ + 查找，右侧设置摘要（可截断）+ `RunControls`（主按钮状态表、试译、立即停止、百分比）；`role=list` 行列表与 roving tabindex；行网格与上下排列容器查询；操作列（⟲ + ⋯）与右键菜单（固定锚点受控 `DropdownMenu`，事件隔离自写）；编辑器（回车换行、Ctrl+Enter、Alt+↓/↑、Esc）；重译弹层（四个 chip、`isComposing`）；页脚（4px 分桶页进度条、状态行含预估与模型、跟随开关、翻页与 `PagePicker`）；跟随与回到当前进度药丸；需关注“已处理”保留；查找结果条；动效与减少动效。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-16-1 | static | required | `pnpm exec tsc --noEmit`；`node node_modules/vitest/vitest.mjs run src/pages/Tools/_shared/ui` | - |
| V-LT-16-2 | visual | required | 1280×860、786×660（含阅读容器 < 700 的上下排列）、深浅主题：未翻译、翻译中、暂停中、需关注、操作列与右键菜单、编辑器、重译弹层、600 页分桶、键盘焦点；工具栏在 880px 一行、722px ≤ 两行 | - |

### T-LT-17 对话框

| 字段 | 值 |
| --- | --- |
| 状态 | 实现完成；V-LT-15-2（Electron UI）与 V-LT-15-3 / 16-2 / 17-2（视觉）未运行——需用户同意后以安静窗口运行 |
| 批次 | I1 |
| 需求 | R-LT-04, R-LT-05, R-LT-06, R-LT-07, R-LT-13, R-LT-17, R-LT-19 |
| 验收 | AC-LT-04-2, AC-LT-04-3, AC-LT-05-8, AC-LT-06-3, AC-LT-07-2, AC-LT-07-3, AC-LT-07-4, AC-LT-07-6, AC-LT-07-7, AC-LT-13-4, AC-LT-17-3, AC-LT-17-4, AC-LT-19-4 |
| 依赖 | T-LT-15 |
| 写集 | src/pages/Tools/Text/LongTextTranslator/dialogs/{SettingsDialog.tsx, RunConfirmDialog.tsx, ExportDialog.tsx, LedgerDialog.tsx, EncodingDialog.tsx, ConfirmDialog.tsx, RenameDialog.tsx, dialogs.css} |

#### 结果

V-LT-17-1：同 T-LT-15 结果（tsc 通过；`_shared/ui` 5 / 7 个文件通过，2 个因依赖解析无法加载）。`test/long-text/dialogs.test.ts` 同批通过。

#### 实现要点

按设计 §3.3-E / F、§3.5 规格表、§5.7“资料选择草稿”：

- `SettingsDialog`（720）：两列网格（< 560 单列）；唯一原文语言 Select；模型 Select（跟随任务模型 + 各档案，缺密钥提示与“去设置模型”）；节奏 `ToolRadioButtonGroup`；文体建议；翻译要求计数；`StudioMaterialsFields` 包在 `.lt-materials` 中（不传 `sourceLocked` / `onAddTerm`）与双向同步；译名表摘要与“管理…”；`Accordion motionOpen` 高级（每批原文长度、单次回答上限、段落识别）；语言 / 段落识别变更时的清除警告与 destructive 保存；页脚预估；“保存并翻译”模式；运行中禁用规则。
- `RunConfirmDialog`（420）、`ExportDialog`（520，主进程选择文件夹、文件名预览、未完成与运行中说明、复制）、`LedgerDialog`（720，搜索、行内编辑即时保存、`aria-pressed` 确认、200 行分批渲染、保存到翻译资料 → 先关闭本对话框再打开 `KnowledgeCaptureDialog`）、`EncodingDialog`（560，预览、编码正确 / 重新打开 / 清除并重新打开）、`ConfirmDialog`（420，删除 / 清除〔`ToolSwitchRow`“保留锁定的段落”〕/ 从此段起）、`RenameDialog`（420）。
- 不使用 `<Checkbox`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-17-1 | static | required | `pnpm exec tsc --noEmit`；`node node_modules/vitest/vitest.mjs run src/pages/Tools/_shared/ui` | - |
| V-LT-17-2 | visual | required | 每个对话框在 1280×860 与 786×540（内容区滚动、页头页脚固定、16px 渐隐）、深浅主题；打开 / 关闭焦点；设置对话框中只出现一个原文语言控件 | - |

### T-LT-18 Agent 页面上下文（可选）

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成（2026-10-22/23） |
| 批次 | I1 |
| 需求 | R-LT-21 |
| 验收 | AC-LT-21-1, AC-LT-21-2 |
| 依赖 | T-LT-16, T-LT-17 |
| 写集 | src/pages/Tools/Text/LongTextTranslator/agent-context.ts, src/pages/Tools/Text/LongTextTranslator/index.tsx（只加一行 hook 调用）, scripts/i18n-usage-manifest.mjs（`AGENT_PAGE_TITLE_KEYS` 加一项） |

#### 结果

V-LT-18-1（可选）：`node node_modules/vitest/vitest.mjs run src/agent/capability-catalog.test.ts src/agent/page-context`（7 项）与 `test/long-text/agent-context.test.ts` 通过（2026-10-23）；`node scripts/check-i18n-usage.mjs` 报 40 个错误，全部在本次未改动的文件中（About、Help、HomeAgent 模板、Setting、Tools 首页 / ToolTile、`src/agent/prompt-templates.ts`），长文本相关为 0。

#### 实现要点

`useLongTextAgentContext(detail)` 调用 `useAgentPageContext({ route:'/tools/text/translator', titleKey:'tools:fields.text_translator', subject: detail?.name, describe: () => ({ document: { name, format, languages, counts, run: status / done / total, page: 当前页标题 } }), instructions: 'Read-only page snapshot. This tool cannot be operated by the assistant yet; describe the state and point the user to the page controls.' })`；不提供 tools 与 suggestions；`describe()` ≤ 1,000 字符、不含正文。成本超出预期时跳过本任务。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-18-1 | interface | optional | `node scripts/check-i18n-usage.mjs`；`node node_modules/vitest/vitest.mjs run src/agent/capability-catalog.test.ts src/agent/page-context` | - |

### T-LT-19 Electron UI 测试与回归

| 字段 | 值 |
| --- | --- |
| 状态 | 测试已编写；V-LT-19-1/2（Electron）与含 test/e2e.spec.ts 的 V-LT-19-3 未运行——不得在用户使用电脑时自动运行，需用户明确同意 |
| 批次 | I1 |
| 需求 | R-LT-02 … R-LT-20 |
| 验收 | AC-LT-02-2, AC-LT-04-2, AC-LT-07-2, AC-LT-08-1, AC-LT-10-3, AC-LT-10-4, AC-LT-12-2, AC-LT-13-1, AC-LT-15-4, AC-LT-17-1, AC-LT-17-2, AC-LT-19-1, AC-LT-19-5, AC-LT-19-6, AC-LT-19-7 |
| 依赖 | T-LT-16, T-LT-17 |
| 写集 | test/long-text/long-text.electron.test.ts, src/locales/{zh,en,ja,zh-Hant}/text.json（只删未使用或补缺失的键） |

#### 结果

V-LT-19-4：`node scripts/check-i18n.mjs` 与 `pnpm exec tsc --noEmit` 通过；`check-i18n-usage.mjs`（含 `--unused=text`）只报 T-LT-18 结果中那 40 个与本功能无关的既有错误，没有 `text` 未使用键（2026-10-23）。

#### 实现要点

按设计 §9.2 的准备与 14 步流程编写，门控 `FUSIONKIT_LONG_TEXT_E2E=1`，安静窗口，`createTestRun(path.resolve('test-results/long-text'))`，夹具在 `<run>/input/`（不用 %TEMP%），假模型服务用 `startFakeModelApiServer()` + `enqueueRoute` 响应函数。跑设计 §9.3 的全部现有检查，先记录 HEAD 基线再比较。`check-i18n-usage --unused=text` 报出的未使用键删除，缺失键补齐（四种语言同步）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-19-1 | e2e | required | `pnpm run pretest; $env:FUSIONKIT_LONG_TEXT_E2E='1'; pnpm exec vitest run test/long-text/long-text.electron.test.ts` | - |
| V-LT-19-2 | ui | required | `$env:FUSIONKIT_TOOL_UI_E2E='1'; pnpm exec vitest run test/tool-spacing.electron.test.ts test/tool-navigation.electron.test.ts test/tool-file-drop.electron.test.ts`（与 HEAD 基线比较） | - |
| V-LT-19-3 | unit | required | `$env:FUSIONKIT_SKIP_E2E='1'; pnpm exec vitest run test/long-text src/store/tools/text src/services/long-text src/lib src/agent/capability-catalog.test.ts src/pages/Tools/_shared/ui test/e2e.spec.ts` | - |
| V-LT-19-4 | interface | required | `node scripts/check-i18n.mjs && node scripts/check-i18n-usage.mjs && node scripts/check-i18n-usage.mjs --unused=text`；`pnpm exec tsc --noEmit` | - |

### T-LT-20 文档、发布说明与最终审计

| 字段 | 值 |
| --- | --- |
| 状态 | 进行中（2026-10-23：README 两份与五个避坑引用已改；CHANGELOG、合并后的审计 JSON 复核与 V-LT-20-1 未做） |
| 批次 | I1 |
| 需求 | R-LT-01, R-LT-20 |
| 验收 | AC-LT-01-2, AC-LT-20-4 |
| 依赖 | T-LT-19 |
| 写集 | README.md, README.en.md, CHANGELOG.md, .agents/skills/fusionkit-pitfall-guard/references/{index.md, markdown-placeholder-drift-repair.md, markdown-output-preserve-source-line-endings.md, use-scrollable-dialog-not-raw-dialog.md, recover-original-explorer-sources-from-shell-temp-proxies.md}, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json（仅在合并后 index.ts 字节变化时） |

#### 结果

README.md / README.en.md 第 107、166 行与 `.agents/skills/fusionkit-pitfall-guard/references/` 下五个文件已按设计 §8.2-9、§8.2-11 修改；`rg -n "text-translation/" .agents/skills/fusionkit-pitfall-guard` 只剩两条历史说明（V-LT-20-2 后半）。

#### 实现要点

按设计 §8.2-9 至 §8.2-11：README 工具表行与隐私句（中英两份）；`CHANGELOG.md` `[Unreleased]` 新条目（预计与 ASR 会话冲突，手动合并，历史条目不动）；避坑引用的旧路径更新。与主线合并后若 `electron/main/index.ts` 或 `electron/preload/index.ts` 字节变化，按最终字节重算两份审计 JSON 的 `currentBlobOid`。确认后续清单（设计 §1.5）已写入任务记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LT-20-1 | interface | required | `node scripts/subtitle-studio-provenance/shared-resource-integration.mjs`；`node scripts/subtitle-studio-provenance/copy.mjs --check`；`node scripts/subtitle-studio-provenance/generate.mjs --check`；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance` | - |
| V-LT-20-2 | static | required | `git diff HEAD --stat -- package.json pnpm-lock.yaml electron/main/ai` 为空；`rg -n "text-translation/" .agents/skills/fusionkit-pitfall-guard` 只剩历史说明 | - |
