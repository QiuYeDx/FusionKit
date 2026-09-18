# 翻译资料：面向字幕工作台的可控翻译（2026-09-18）

本轮补充现有 [V3 设计](../FusionKit_AI_Translation_Design_V3.md) 与 [实施记录](implementation.md) 的用户体验要求。用户要求自行评审、沉淀方案并连续实施。当前产品范围明确为：**翻译资料只供字幕工作台使用；经典字幕 AI 翻译器完全不涉及翻译资料。** 本文以此范围为最终设计依据。

## 实查结论

资料库不是自动加入所有请求的全局上下文。工作台普通翻译不读取资料库；资料翻译只解析用户选择的资料集和方案依赖，再检查本机采纳的准确修订、语言、内容对象、条件和术语命中，最后按预算编译。任务保留冻结执行记录。转写后自动翻译的资料开关也默认关闭。

用户无法从原界面推导这些行为，形成“保存后全量应用”的印象，属于产品缺陷：

| 问题 | 现有证据与影响 | 本轮决定 |
| --- | --- | --- |
| 管理与执行关系不明 | 资料页主要介绍备份/分享，工作台管理链接未解释使用闭环 | 常驻说明保存不等于启用，提供创建、采纳、到工作台选用三步及直接操作 |
| 正式资料翻译藏在试译 | `StudioTranslation` 额外弹窗默认片段试译；父开始按钮仍走普通路径 | 默认关闭的任务级开关；开启后只能进入资料检查/翻译，默认全文 |
| 选中哪些内容不可见 | 子弹窗关闭后父表单没有资料摘要 | 回显方案/资料集，未选时明确提示；默认不全选 |
| 产品入口边界不清 | 经典字幕工具中的资料入口容易让人误以为其翻译任务会使用资料 | 经典字幕 AI 翻译器不提供资料入口、开关、提示、文件转交或配置关联；资料使用入口仅在工作台 |
| 首次创建负担大 | 对象、资料集、五类条目、风格/方案并列；创建集后还要自行找到加条目 | 推荐先做术语；无资料集时创建后直接续接条目；示例与范围说明随任务出现 |
| 能力说明过时 | 文案仍称正式翻译未启用；表达/参考译文保存与执行混淆 | 修正四语言；明确术语/背景/规则可用于翻译，表达/参考译文当前仅保存 |
| 语言与隐藏偏好易误用 | 默认日语；方案可覆盖子表单目标；积累偏好并未执行 | 原文语言需明确确认，目标跟随工作台任务且不被方案静默替换；未启用偏好放入说明明确的高级区域 |

## 用户流程与边界

1. 在资料页创建一个资料集（例如“旅行视频术语”，指定语言），添加术语（例如 `checkpoint → 存档点`），核对后“保存并采纳”。对象、条件、方案均可后续再配置。
2. 在字幕工作台上传字幕，打开单文件或批量翻译设置。默认“不使用翻译资料”；开启后选择资料集或已有方案，查看本次范围。没有可用资料时提供管理入口。仅采纳且匹配的背景/术语/规则有资格参与，选择不代表每条都必然加入请求。
3. 检查资料与请求预算不调用模型；检查后明确开始才发请求。修改选择、源文、模型或预算使检查失效。检查失败不能自动回退普通翻译。
4. 单文件先呈现全文翻译，片段试译作为可选验证。批量使用共同资料范围并保留逐文件检查结果；工作台转写后的自动翻译使用独立资料开关，保留既有入队冻结规则。

经典字幕 AI 翻译器的界面、配置、队列、文件选择和执行均不连接翻译资料。资料页“去翻译”直接进入字幕工作台，不经经典工具中转。暂不扩展表达/参考译文检索、自动积累或云资料库，也不把暂存能力标为已参与翻译。

## 界面设计基准

遵循 `fusionkit-ui-design`、`qiuye-ui-quality` 与项目 pitfall guard。参照既有 `ToolConfigPanel`、`ToolSwitchRow`、`ToolPanel`、`ToolField`、`ScrollableDialog`，中性配色、12px 面板留白、16px 字段间隔，沿用圆角和焦点语义。

- 资料页：顶部简短规则 + “如何使用”渐进说明；空库展开三步，有内容时默认折叠，不长期挤压列表。操作入口与步骤对应。新建术语优先显示原文、译文、语言与采纳；译法/匹配和标题/来源为折叠的可选设置。保留资料/方案/审核视图和既有数据。
- 工作台翻译设置：模型、目标、翻译要求 → 资料开关及摘要 → 高级预算 → 当前模式的主操作。启用资料时不能出现仍可执行普通翻译的主按钮。
- 选择表单复用已验证的生命周期，方案带入依赖可解释；保留范围/冲突细节的折叠层。无方案时隐藏空方案选择，无内容对象时隐藏空主题区域，没有逐句范围时不解释不存在的范围状态。
- 空态、读取失败、过期、缺失/归档资料与未采纳状态必须给出准确下一步。源/目标语言使用资料执行契约校验，非法自定义语言不能静默替换为中文。
- 父语言或预算输入暂时无效时仍保留资料草稿，通过禁用和处理函数校验阻止执行；用户自行填写的要求不随父目标变化丢失。
- 长资料集名自然换行；820px 窄窗、中文浅色与英文深色取样，弹窗固定操作区与正文滚动，不能通过全局裁剪遮挡问题。

## 验收条件

- AC1：新用户能从资料页读到保存与使用的区别，并完成资料集→术语→明确采纳→进入字幕工作台的连续流程。
- AC2：工作台单文件/批量配置默认不用资料；开启后父普通执行路径在 UI 和函数入口两层阻止。选集、清空、关闭重开后状态准确。
- AC3：原文语言经明确选择，目标语言与父任务一致；换方案不静默改变目标；不全选资料库。语言/预算暂时无效时保留草稿和显式要求。
- AC4：本机 HTTP fixture 证明检查阶段零请求、开启只发所选匹配资料，工作台普通翻译不含资料；既有冻结/冲突规则不退化。
- AC5：经典字幕 AI 翻译器没有资料入口、开关、说明、跳转或配置关联，文件选择与任务执行沿用自身流程；资料页的使用入口直接指向工作台。
- AC6：四语言说明与实际可执行能力一致；表达/参考译文、偏好与积累不制造功能已生效的假象。
- AC7：类型、针对性行为测试、i18n、根 Vite 三段构建/preload 通过；真实隔离 Electron 交互与最终截图经审阅；结束清理本轮服务。

## 实施与验证台账

| 任务 | 写入范围 | 状态 |
| --- | --- | --- |
| UX1 产品文档、资料页首次使用与能力说明、四语言 | 本目录、`src/pages/TranslationKnowledge/`、`src/locales/*/knowledge.json` | 已完成 |
| UX2 工作台单文件/批量/自动资料选用及配置草稿生命周期 | StudioTranslation/KnowledgeTrial/KnowledgeBatch/AutomaticKnowledge 与对应 Electron 用例 | 已完成 |
| UX3 经典字幕 AI 翻译器边界核对 | 移除资料关联，检查原文件选择、配置和队列行为 | 已完成 |
| UX4 集成、原生验证、审查修复与清理 | 最终集成工作树 | 已完成 |

依赖与锁文件不属于写集；使用已安装 Node 工具（Node v20.19.5、pnpm-lock v6），不安装或升级依赖。以下验证只认最终工作台限定版本；此前包含已移除功能的测试数量和通过结果不计入本版验收。

### 审查后保留的修复

- 首次术语录入原先需要滚动穿过大量低频设置才能采纳，现折叠匹配细节、标题与来源，保留完整编辑能力。
- 批量子表单的要求原先被父语言更新覆盖，现分离目标语言同步与用户文字，保留显式覆盖和显式空字符串。
- 方案原先能悄悄把英文目标改成中文，现明确禁止静默替换；测试先验证不匹配提示，再在父表单选择正确目标。
- 批量自定义目标原先把列表外的值默认为中文，现仅兼容 `zh → zh-Hans`，其余保留输入，非法标签明确阻止检查。
- 父配置暂时无效原先会卸载资料子表单，现保留有模型的配置草稿与资料组件，禁用执行；原始输入变化仍使旧计划失效。
- 关闭父表单清除一次性打开指令，避免重开父表单时自动再开资料弹窗；关闭资料弹窗保留父开关和本次选择摘要。
- 无内容对象时隐藏对应空字段和范围说明，减少无法对应操作的文字。

相关经验沉淀为项目避坑记录 **FK-PIT-0161**：`keep-translation-material-opt-in-visible-and-executable.md`。

## 最终验证记录

| 验收 | 最终版本证据 | 结果 |
| --- | --- | --- |
| AC1 | consumer 原生用例完成首次资料集/术语/明确采纳，并从资料页直接进入工作台、原生选择导入字幕 | 通过 |
| AC2–AC3 | consumer/formal/batch 覆盖默认关闭、选集/清空/重开、父普通路径阻止、目标一致、非法语言、临时无效预算和草稿保留 | 通过 |
| AC4 | HTTP fixture 证明检查零请求、普通请求无资料；另建同样命中字幕的未选资料集，确认其内容不进入请求；领域回归覆盖冻结/恢复/冲突 | 通过 |
| AC5 | 经典页无资料入口或模式，真实上传后停留自身队列，工作台文档数量不增加；源码无资料引用或转交服务 | 通过 |
| AC6 | 四语言完整性及源码 key 检查；资料页说明明确限定字幕工作台；经典中文浅色/英文深色截图 | 通过 |
| AC7 | TypeScript、Vite 三段构建/preload、边界/来源/协议检查、170 项行为测试及 4 条原生场景；截图与进程检查 | 通过 |

使用仓库已安装的 Node 工具运行，未调用未固定版本的 pnpm：

```sh
node node_modules/typescript/bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node node_modules/vite/bin/vite.js build --mode=test
node scripts/check-preload-bundle.mjs
node scripts/subtitle-studio/check-boundaries.mjs
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check
node scripts/translation-knowledge/build-artifacts.mjs --check
```

均通过。边界扫描 492 个文件、0 错误；来源检查 120 个冻结文件及执行器 1 文件/26 依赖；协议检查 3 个产物。四语言齐全，2,922 个源码 key 可解析；保留 21 条既有同源文案警告。Vite 有既有 chunk 大小与混合导入警告，无构建错误。日志为 `/tmp/fusionkit-studio-only-build.log`、`/tmp/fusionkit-studio-only-i18n.log`、`/tmp/fusionkit-studio-only-i18n-usage.log`。

```sh
node node_modules/vitest/vitest.mjs run \
  test/translation-knowledge/execution.test.ts \
  test/translation-knowledge/ui-model.test.ts \
  test/translation-knowledge/automatic-service.test.ts \
  test/subtitle-studio/knowledge-translation.test.ts \
  test/subtitle-studio/knowledge-batch-translation.test.ts \
  test/subtitle-studio/knowledge-trial.test.ts \
  --maxWorkers=1 --minWorkers=1
```

**6 个文件、170 项测试通过**，耗时 13.14 秒；日志 `/tmp/fusionkit-studio-only-tests.log`。已删除的经典工具交接服务测试不计入数量。

本轮原生验收覆盖以下四个文件：

```sh
FUSIONKIT_KNOWLEDGE_E2E=1 node node_modules/vitest/vitest.mjs run \
  test/translation-knowledge/consumer-ux-electron.test.ts \
  test/translation-knowledge/formal-electron.test.ts \
  test/translation-knowledge/batch-electron.test.ts \
  test/translation-knowledge/electron.test.ts \
  --maxWorkers=1 --minWorkers=1
```

**四条场景的最终逐文件结果均通过**。全文与批量结果在 `/tmp/fusionkit-studio-only-native.log`；首次使用与资料管理结果在 `/tmp/fusionkit-studio-only-native-entry.log`（2 条通过，56.51 秒）。首轮 consumer 测试误把经典待开始队列视为刷新后自动恢复，修正为按原有内存队列行为重新选择文件，再验证通过；未改变经典队列恢复机制。旧管理用例中要求两个工具都显示资料入口的断言也已改为仅工作台。

### 渲染与清理

实际查看了本轮 `test-results/translation-knowledge-consumer-ux/` 中的截图：

- `classic-translator-zh-light-wide.png`：经典工具的标题区没有资料按钮，原有语言、输出、分片、定时配置和上传/队列完整保留。
- `classic-translator-en-dark-narrow.png`：820×700 英文深色窗口，原上传区和自身任务队列可读、操作可达；无资料模式说明或文件转交控件。
- `studio-materials-unselected-zh-light-wide.png`：工作台显示两个可选资料集，默认均不勾选；未选择时检查/开始禁用，全文模式、语言与操作区可见。

首次使用、术语采纳与选中后的检查截图由同一原生用例重新生成；formal/batch 用例同时更新全文配置和英文窄窗逐文件结果。测试等待全局 loading 退出、使用隔离资料目录和本机 HTTP fixture，证明交互、请求内容和生命周期，不证明真实模型翻译质量；不包含 Windows 安装包或真实 ASR 推理。

本轮未启动常驻 Vite 服务。测试 Electron 与本地 HTTP fixture 均已退出；保留本轮开始前已有的用户 Electron PID 40187 及其子进程。`git diff --check` 通过，`package.json` 与 `pnpm-lock.yaml` 无变更。
