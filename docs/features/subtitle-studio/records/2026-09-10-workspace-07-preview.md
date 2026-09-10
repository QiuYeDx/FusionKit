# T-WORKSPACE-07 重复混排预览与页码跳转

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-07 |
| 日期 | 2026-09-10 |
| 验证版本 | 基线 019bb3b111c122561ed1d4e0340a9f9e27002eaf 加未提交工作树；源码摘要 84bd5c7cff1e1d459f159fcea35668581d917bae56b03660d55793db1547902c |
| 环境 | macOS arm64；既有 pnpm 8.7.0 安装的 node_modules；Vitest 2.1.9、Vite 5.4.21、Electron 41.10.6、Playwright 1.58.2；未安装依赖、未改 lockfile |
| 任务指纹 | ecbf6677b2aa46baf289ef0a92a9b0b1f85e97380cb49beb718d2862379a68f9 |

## 实际结果

用户本轮报告勾选空格拆分后预览仍不正确，要求修复并支持输入页码跳转，授权在原 T07 范围继续完善；AC 不变，不推进 T04/T05/I2/I4。保留 [初版记录](2026-09-09-workspace-07.md) 和 [前次混合双语修复](2026-09-09-workspace-07-mixed.md) 的历史证据。

截图的第 41/42 条时间为 00:29:05.840、00:29:08.540。读取原始文件确认：两个同时间节点都存有完整“日文 空格 中文”，且两个正文完全相同。这是前次“第一侧混排、另一侧只有译文”之外的输入形态。原实现有意保留相同正文，所以这类条目的预览和提交实际都会保留两份完整混排；IPC/main/preload 没有重写预览正文。不能只改显示文字掩盖领域结果。

开启 splitInline 时，现在对完全相同的结构正文提供可识别且不同字种的空白分界，默认优先日文→中文；保留 same_time/lines 类型和双方原节点，从第一侧取前段、第二侧取后段。原文方向切换、可选分界和保持原样均支持，候选标为需确认。纯汉字或其他缺少可识别分界的普通同文不猜测拆分。预览与提交仍共用分析函数，原文/译文范围保留样式、时间、UTF-16 偏移、原节点映射及原始字节。

结构候选的空白分界通过原有 splitChoices/splitAt 传递；普通 SRT 双行不再显示无用的换行分界选项。关闭空格拆分时清除显式行内分界覆盖，保留结构候选的“保持原样”；不会留下不可见的分界选择。

弹窗复用 StudioPagination，新增可传 pageSize=20，主表继续默认 100。底栏显示条目范围、当前页输入和总页数；输入有效页码按 Enter 跳转，空值、小数、越界值不切页，失焦回当前页。筛选和配置变化返回第一页，页数依据过滤后的候选数更新，翻页后内部滚动区回顶部。文案沿用四语言现有键，无新语言资源或协议/持久化 schema。

## 验证结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-08-1 | 通过 | V-WORKSPACE-07-1, V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |
| AC-WORKSPACE-08-2 | 通过 | V-WORKSPACE-07-1, V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |
| AC-WORKSPACE-08-3 | 通过 | V-WORKSPACE-07-2, V-WORKSPACE-07-3, V-WORKSPACE-07-4 |

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-07-1 | 通过 | inline: bilingual-mixed 46 项、bilingual 23 项、formats 17 项共 86 项通过；重复整串 same_time/lines × sourceSide、选择分界、保持原样、关闭开关、纯汉字/同语反例、前导空行与代理对偏移、样式和原节点映射均覆盖 |
| V-WORKSPACE-07-2 | 通过 | inline: bilingual-service 24 项、IPC 8 项、translation-service 35 项共 67 项通过；事务、权限、过期修订、清轨及重新翻译回归；用户文件测试另核对重启/原始字节/清轨 |
| V-WORKSPACE-07-3 | 通过 | inline: 隔离 Electron bilingual-ui 最终通过，合成 45 组字幕的第 3 页、预览双列、分界/跳过/开关/反向、无效页码/首尾边界/筛选/滚动、清轨后模拟模型请求无旧译文；真实 LRC 需确认第 3 页 41–60/695（截图报告位置）、实际整理后主表第 30 页；桌面/窄窗截图已实际审阅 |
| V-WORKSPACE-07-4 | 通过 | inline: 授权 LRC/SRT 本地测试 2 项通过，155 项不同非 UI 用例加 2 项 Electron 流程；根 Vite 构建和 preload 检查通过，bundler TypeScript 通过，边界 96 文件/0 错误；locale 四语言各 128 studio 键完整，i18n usage 既有失败详见下方；diff/spec ready/approval 检查通过，测试进程清理完成 |

使用现有二进制验证，未调用 pnpm 安装或 pretest 原地构建：

```sh
node_modules/.bin/vitest run test/subtitle-studio/bilingual-mixed.test.ts test/subtitle-studio/bilingual.test.ts test/subtitle-studio/formats.test.ts --maxWorkers=1 --minWorkers=1
node_modules/.bin/vitest run test/subtitle-studio/bilingual-service.test.ts test/subtitle-studio/ipc.test.ts test/subtitle-studio/translation-service.test.ts --maxWorkers=1 --minWorkers=1
FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE='/path/to/authorized/bilingual' node_modules/.bin/vitest run test/subtitle-studio/bilingual-local-files.test.ts --maxWorkers=1 --minWorkers=1
node_modules/.bin/tsc --noEmit --moduleResolution bundler --module esnext
node scripts/subtitle-studio/check-boundaries.mjs
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
# 以下在临时源码副本中执行；共用既有 node_modules，隔离 Electron userData
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
FUSIONKIT_STUDIO_E2E=1 FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE='/path/to/authorized/bilingual' node_modules/.bin/vitest run test/subtitle-studio/bilingual-ui.test.ts --maxWorkers=1 --minWorkers=1
FUSIONKIT_STUDIO_E2E=1 node_modules/.bin/vitest run test/subtitle-studio/workspace-ui.test.ts --maxWorkers=1 --minWorkers=1
```

## 实际文件与渲染审查

仅本地读取用户指定的 LRC/SRT，在临时仓库转换；未发送用户字幕到 API，未将字幕正文存入跟踪测试 fixture。LRC 原有 59 组相同结构正文中，46 组包含完整重复混排、13 组是普通同文。46 组均从原始文本独立推导分界，分离后全部与对应 SRT 两行一致；SRT 只做第二重对照，未用其覆盖 LRC。前次 282 处重复尾段仍正确，其中既有 1 处源文件版本用词差异保留。

LRC 7615→3930 cue，需复核 695、未配对 0；SRT 3931 cue，3930 对，需复核 135、未配对 1。新增逐页核对 LRC 35 页与 SRT 7 页，合计 830 条需复核候选的 first/second 严格等于最终 source/target，避免只断言最终表格而遗漏预览中的正文问题。

使用 qiuye-ui-quality、FusionKit UI Design 和项目 pitfall guard；参照现有弹窗与主表的共享分页，保持 12px 底栏留白、32px 图标热区和 28px 页码输入。最终审阅 real-lrc-reported-preview.png、pagination-narrow.png、preview-desktop.png：原/译文各自清楚分离，顶部选项完整；786×540 窄窗中页码与确认按钮完整可达，底栏仍单行、无横向溢出；1280×860 真实长文件名/多位页数正常。Enter、失焦和禁用行为通过实际交互验证，未把未截图的焦点保持状态写成已测。

截图存于本机忽略目录 test-results/subtitle-studio-bilingual-preview/，原工作台回归图置于其 workspace-regression/。使用隔离 userData 和原生 Electron/preload 流程；模型重译仅使用本地模拟 HTTP 返回。

## 风险与未执行项

既有已整理文档不自动改写；使用修复需重新导入原文件并确认。语言识别是本地字种启发式，有歧义时仍需复核；不宣称任意语言混排都能自动语义对齐。尚未实现的导出模式和编辑保持后续计划，本记录不是 I1 整体验收；未验证 Windows。

本轮 i18n usage 再次核对仍为 NameTranslator OptionsPanel.tsx:117 动态 key 与旧 manifest 两项既有错误，未涉及本次改动；locale 完整性通过。默认 TypeScript 的已知 observer 模块解析基线未重跑，补充 bundler 模式通过。构建仍有既有大 chunk/混合引用警告。

最初 Electron 在沙箱内启动被系统 SIGABRT 中止；使用获准的扩展执行启动隔离测试后正常。首轮 bilingual-ui 通过，workspace-ui 停在无关文件名 hover tooltip 等待；未修改源码或删除断言，单独复跑 workspace-ui 全流程通过（33.77s）。将该次失效保留为运行时序记录，不冒充首次全绿。

构建使用 /private/tmp/fusionkit-studio-preview-8j8pgb_z，避免根配置删除用户正在运行的 dist-electron。交付前逐字节比较最终生产文件及 bilingual-ui 测试与构建副本一致，取回截图后删除临时副本。Electron、模拟 HTTP 和测试临时目录已清理；进程表匹配本轮隔离标识为空，未关闭用户原有应用。依项目避坑流程隔离构建和清理服务；.agents 只读，本次经验记录在本文件。

源码摘要覆盖 git ls-files -m -o --exclude-standard 去重排序后排除 docs/ 的 7 个文件；SHA256 依次累计路径、NUL、文件字节、NUL。范围指纹 3d99de12c0481ca432a77e13865132bcc120f51db162c8a54f26d546f6bdaad1，批次指纹 f68dbbd21cdc52c1d87c4f3814279bab2fed5bb4e37b881a4fb245a0a3ef7d8b。
