# 2026-09-08 独立字幕工作台设计记录

## 授权与交付范围

用户先认可统一字幕结构，再明确要求独立新工具、保留现有工具作为可用 v1、未来可删除 v1、必要时复制转写实现保证效果，并要求落实文档及说明下一步。本轮只完成设计文档，不修改产品代码，不执行模型请求、归档、迁移或删除。

这替代上一轮对话中“在现有工具内迁移 checkpoint/交接”的建议：新版不承担旧检查点升级，也不调用旧工具的 artifact handoff；v1 保持原状。用户已认可方向，但未指示本轮开始实现，spec.json 保留实施授权 pending；这不是文档工作需要额外批准。

## 基线与查阅范围

- Git HEAD：`152b5632bcac4d93e8d44530c892fa9b55776463`。
- 环境：Windows / PowerShell，仓库根 `C:/Users/Administrator/Documents/GitHub/FusionKit`；package.json 应用版本 0.3.0。
- 开始时有无关未跟踪文件 `.agents/skills/fusionkit-pitfall-guard/references/diagnose-windows-vite-eacces-as-a-reserved-port.md`，保留未动。
- Git 在隔离账户中提示 ownership 不同；仅使用单次 `git -c safe.directory=...` 完成只读查看，没有修改全局 Git 配置。
- 阅读了当前 SRT/LRC translator、subtitleCueProtocol/prompt、base-translator/checkpoint、LocalSubtitleTranscript、artifact handoff、production-executor/pause-window-plan、应用入口、preload 和打包规则。
- 核对了 phase12 任务与收束记录、phase13 停顿分块默认推广记录。没有重跑历史原生样本，因此这些历史通过结果不计为新版验证。

## 重要设计决定

1. 工作名“字幕工作台”，独立 route/toolId/store/IPC/main service，不替换 v1 路由或默认值。
2. 文档、任务、导出产物分别持久化管理；源修订与时间修订分开，导出选项不影响翻译有效性。
3. I1 建立 SRT/LRC 文档→翻译→重启后多次导出的完整链路；后续仅滚动规划转写、ASS、编辑，不先建立完整编辑器。
4. 原生能力采用有来源清单的生产闭包复制；复制有效默认策略及质量处理，先回放等价，再做真实限定对照。当前 acoustic_quiet_v1/VAD 与已知缺陷如实继承，不把历史人工接受范围扩张为普遍正确。
5. 新版模型和原生资源独立所有权，允许显式导入后复制，禁止链接到 v1。接受初期磁盘/维护重复以换取可删除性。
6. 发现旧 builder 校验要求恰好一个资源和旧 hook；直接添加第二份资源不可行。I2 采用独立双工具构建组合与新版验证副本，不修改/削弱旧校验文件，不用伪造 config 绕过检查。
7. 可删除性检查覆盖传递依赖、构建/资源字符串、测试 helper 和隔离副本实际移除；不能仅凭目录不同作结论。

## 技能约束对方案的影响

使用 spec-driven-ai-coding 的 L 滚动规划：BRD 管全局目标，只展开 I1 需求/设计/六项任务，后续 deferred，任务状态与授权分开维护。

使用 fusionkit-pitfall-guard 中已存在的跨工具交接、字幕路径迁移、按产品风险控制预研、原生 runtime、低音量回退及句界证据指导。用户本轮明确选择独立复制，优先于历史方案里的跨 v1 artifact handoff：保留独立所有权原则，交接改在新版内部进行。格式导出不按字数发明时间，转写复制包含生产后处理而不是只保留模型调用。

## 设计验证

运行技能的 `check_spec.py docs/features/subtitle-studio --stage ready --json`。首轮提示需求缺少规定的“边界与异常”章节，以及设计章节名与结构约定不一致；补充了具体异常语义并调整章节名，未删除验收要求。

修正后 ready 结果：errors=[]、warnings=[]；覆盖当前 7 条需求、15 条 AC 和 6 项任务，无依赖环。scope_digest 为 `0af995391863ef6672caa6bf64bbc33f5cd3a0a2b1db319fa5c4ed64d7133eed`。这是文档结构与引用检查，不证明实现通过或获得实施批准。

语义复核关注：双语模式与翻译解耦；原文/译文/时间身份；LRC 无结束时间、多标签与 offset；格式损失；崩溃恢复与迟到结果；v1 不迁移；副本的类型品牌、模型目录、构建 hook、签名与删除闭包；旧转写已知不足不伪装解决。未发现阻断 I1 设计的产品选择。

最终检查：8 个 Markdown 文件、16 个本地链接全部存在，无模板占位符、未闭合代码围栏；9 个文档文件（含 spec.json）无尾部空白或缺少末尾换行。再次 ready 检查通过。`git diff --check` 对已跟踪内容无输出；新增文档尚未跟踪，因此另用逐文件空白检查覆盖，未将空的 Git diff 当作新文件检查证据。最终 Git status 仅显示原有无关未跟踪文件及新建的 docs/features/，没有业务代码修改。

## 未执行与后续

尚未写业务代码，未运行产品单元测试、真实 AI/ASR、Electron UI 或打包，也未执行实际 v1 删除演练。全部实现任务保持未开始；上述检查在对应任务实施后执行，缺环境时保留待验证。

下一可执行动作是获得开始 I1 的实施指令后执行 T-WORKSPACE-01：核对新基线/未提交改动、建立边界检查，做真实导入→文档→源预览/导出的最小链路。转写复制前另冻结实际生产版本；本轮 HEAD 不强制锁死未来复制来源。
