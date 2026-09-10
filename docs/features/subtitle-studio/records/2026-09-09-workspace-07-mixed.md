# T-WORKSPACE-07 混合双语重复尾段修复

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-07 |
| 日期 | 2026-09-09 |
| 验证版本 | 基线 019bb3b111c122561ed1d4e0340a9f9e27002eaf 加未提交工作树；源码摘要 a688fde637a947c7d86b78c23524e6a31b64c83fdecad460e0776434fb751cfd |
| 环境 | macOS arm64；既有 node_modules（pnpm 8.7.0 安装布局），Vitest 2.1.9、Vite 5.4.21、Electron 41.10.6、Playwright 1.58.2；未安装依赖或更新锁文件 |
| 任务指纹 | cd45fed782efb0f4f37f7dce732d9fadb941927b45eeb3f6766d197e687b8d27 |

## 实际结果

用户本轮明确要求完善混合双语处理：同一个文件既有原文/译文分行，也有空格分隔的行内双语，勾选行内拆分后原文仍夹带译文。此指令授权修复既有 T07，保留 AC-WORKSPACE-08-1 至 08-3；未推进 T04/T05/I2/I4。初版实现及验证保留在 [历史 T07 记录](2026-09-09-workspace-07.md)，本记录只补本轮变更证据。

实际问题是结构配对与行内拆分原先互斥：遇到“第一行含原文和译文、第二行再次出现译文”的同时间双行时，结构配对已占用两行，后续行内分析无法清理第一行的重复译文。SRT 同块双行也存在同类路径。

现在启用 splitInline 后，对 same_time/lines 结构配对的双方继续检查完整重复尾段。只有尾段与另一侧正文完整相同、前有空白分隔，且字种或稳定中日文档证据支持时，才收缩对应字符范围。原文方向可反转，另一侧保持不变，修正候选标为需确认。纯汉字双方依赖至少三组、占结构配对 80% 的稳定中日语言顺序；证据在清理前计算，排除单行候选，包含被跳过的结构对，避免用户跳过操作人为提高置信度。

未启用行内拆分、被跳过、双方相同、仅部分后缀相同、缺少分隔或语言证据不足时保持原样。原节点、样式、时间、原始字节和解释来源仍保留；预览与提交共用同一范围计算。没有修改前端实现、IPC、持久化结构、依赖或 lockfile。已整理文档不会自动迁移，需重新导入原文件、开启行内拆分并确认。

## 验证结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-08-1 | 通过 | V-WORKSPACE-07-1, V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |
| AC-WORKSPACE-08-2 | 通过 | V-WORKSPACE-07-1, V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |
| AC-WORKSPACE-08-3 | 通过 | V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-07-1 | 通过 | inline: bilingual 23 项、bilingual-mixed 30 项、formats 17 项；覆盖 LRC/SRT 混合结构、开关、双向原文、跳过、稳定语言证据与阈值反例、同文保留、空白/样式范围、hash/时间/原字节不变 |
| V-WORKSPACE-07-2 | 通过 | inline: bilingual-service 24 项、IPC 8 项、translation-service 35 项；权限、修订、事务、重读、清轨和重译保护回归通过；真实文件回归另核对转换后持久化、清轨和映射 |
| V-WORKSPACE-07-3 | 通过 | inline: 隔离 Electron bilingual-ui 最终流程通过；混合 LRC 开关与预览/提交、反向 SRT 第二行重复、清轨后模拟模型请求不含旧译文、真实 LRC 第 30 页 2972 至 2977 条正文断言；桌面和窄窗最终截图已实际打开审查 |
| V-WORKSPACE-07-4 | 通过 | inline: 获准本地 LRC/SRT 两项回归通过；139 项不同自动化用例通过，另有上述 Electron 流程；根 Vite 配置在临时源码副本构建及 preload 检查通过，bundler 模式 TypeScript 通过，边界检查 96 文件/0 错误，git diff --check 通过；未改 locale，既有全局检查限制见下方 |

主要复现命令使用既有二进制，避开 pnpm 版本变化和 pretest 原地构建：

```sh
node_modules/.bin/vitest run test/subtitle-studio/bilingual.test.ts test/subtitle-studio/bilingual-mixed.test.ts test/subtitle-studio/formats.test.ts test/subtitle-studio/bilingual-service.test.ts test/subtitle-studio/ipc.test.ts test/subtitle-studio/translation-service.test.ts --maxWorkers=1 --minWorkers=1
# basename 使用获准的本地同名 LRC/SRT，省略扩展名
FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE='/path/to/subtitles/bilingual' node_modules/.bin/vitest run test/subtitle-studio/bilingual-local-files.test.ts --maxWorkers=1 --minWorkers=1
# 以下在临时源码副本中执行，共用现有 node_modules
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
FUSIONKIT_STUDIO_E2E=1 node_modules/.bin/vitest run test/subtitle-studio/bilingual-ui.test.ts --maxWorkers=1 --minWorkers=1
```

## 真实文件结果

使用用户指定 Documents/字幕 目录中的同名 LRC/SRT，仅本地读取和临时仓库转换，没有外部 API 请求，没有把字幕正文复制到跟踪测试文件。测试直接从原始 LRC 文本独立计算预期结果，逐条检查所有结构配对，避免只根据生产分析结果推导断言。

| 本地文件 | 导入 cue | 结构配对 | 单行配对 | 整理后 cue | 需复核 | 未配对 |
| --- | --- | --- | --- | --- | --- | --- |
| 用户指定 LRC | 7615 | 3685 | 245 | 3930 | 695 | 0 |
| 用户指定 SRT | 3931 | 3930 | 0 | 3931 | 135 | 1 |

LRC 中 282 组结构配对包含重复的译文尾段，已全部分离；其中 281 组修正后与对应 SRT 正文一致。06:02:54.910 的一组源文件版本用词不同，保持 LRC 原文，未用 SRT 覆盖。59 组原译文完全相同的配对保留双方。复核数包括字种歧义及本次清理候选，不等于错误数。独立单行存在多个可能空格分界时仍需用户确认，本次不将数量正确当作全部语义无歧义的证明。

最终截图位于本机忽略目录 test-results/subtitle-studio-bilingual-mixed/。已审阅 real-lrc-imported.png（用户反馈的第 30 页）、preview-desktop.png 和 review-narrow.png；第 2972 至 2977 条原文已无重复中文尾段，译文保持正确。截图不随 Git 同步。

## 风险与未执行项

没有重跑无关的全局已知失败：默认 tsc 的 smooth-corners/observer 模块解析，以及 i18n usage 的 NameTranslator 动态 key/stale manifest，历史证据见初版记录。此次采用 --moduleResolution bundler --module esnext 的类型检查通过。构建仍有既有大 chunk/混合引用警告；未验证 Windows，不声明 I1 整体验收。

构建在临时源码副本执行，避免根 Vite 配置清理用户正在运行的 dist-electron。测试 Electron、模拟 HTTP 服务均已关闭，临时副本已删除，截图已取回；进程表中本轮 fusionkit-studio-mixed、studio-bilingual-ui、studio-bilingual-local 隔离标识均为空。保留用户自行启动的应用，不遗留本轮前端服务。

本次经验：结构分组与内容拆分应能组合，真实样本验证必须核对双方正文而非只统计配对数；置信度的文档样本不应随用户跳过候选而缩小。因 .agents 为只读，经验记录于此。

源码摘要算法：git ls-files -m -o --exclude-standard 去重排序并排除 docs/，SHA256 依次累计路径、NUL、文件字节、NUL，共 4 个源码/测试文件。范围指纹 3d99de12c0481ca432a77e13865132bcc120f51db162c8a54f26d546f6bdaad1，批次指纹 c40a89033fe8383cfae00d2a68512ba8cd7ce61c4b0c666df15332f81db5fb29；此处为真实工作树快照，不是尚未创建的提交。
