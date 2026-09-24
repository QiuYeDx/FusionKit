# 翻译资料编写 Skill 与保存入口

## 结果

配套技能的唯一源迁至 `.agents/skills/fusionkit-translation-knowledge/`，旧 `skills/fusionkit-translation-knowledge/` 移除。Skill 版本升级为 2.0.0，文件协议仍为 FK-TK/1；没有改变导入数据协议。

翻译资料页左侧导入／导出下方新增「保存资料编写 Skill」。通过现有受控知识 IPC 打开原生保存对话框，输出 `fusionkit-translation-knowledge.zip`；成功后说明解压并交给 AI 工具。取消无成功提示，保存失败可重试，已有文件不被覆盖。空资料库与库维护状态不妨碍获取技能，保存不读取用户资料。

## 技能更新

- 明确当前执行的是术语、背景与要求，表达／参考译文仅存储；偏好继承和自动积累不是已实现承诺。
- 分类对象与硬使用范围分开；普通集无额外绑定，人物口吻要求正确 speaker。
- 补充日文字面匹配、多义词／重叠术语、共通与作品分层、多包共享 ID、本地双语字幕及版本抽样经验。
- 说明候选导入后的批量审核流程，保留来源证据和本机采纳边界。
- 新增不需要对象绑定的日中入门示例；高级示例与无依赖离线 CLI 保留。

## 维护与分发

`node scripts/translation-knowledge/build-artifacts.mjs`（或 `npm run knowledge:artifacts`）从应用协议生成 Schema、便携校验器和嵌入主进程的 ZIP。文件名单显式限定为技能说明、协议参考、有效示例与校验器，不分发测试反例、私人资料或工作区目录。

源文本统一 LF，ZIP 固定时间戳，因此 Windows CRLF 检出不会改变分发内容。生成包直接随 main bundle 打入安装包，离线运行不依赖项目源码目录或额外下载。

`npm run knowledge:check` 比较生成产物与权威源。Vite 的启动／构建入口自动执行该检查，修改技能或协议后未重新生成时阻止携带旧包构建。不要手改生成模块的 Base64，也不要在旧路径保留第二份技能。

## 验证

- skill-creator `quick_validate.py` 通过。
- 协议、IPC 与技能 ZIP 测试：验证包文件和引用闭合、日中示例生效范围、脱离仓库的 CLI、取消／不可覆盖／关闭中迟到对话框／无路径权限扩张，以及 LF/CRLF 一致性。
- TypeScript、四语 locale parity 与源码键使用检查通过。
- 根 Vite 的 renderer/main/preload 三段构建和 preload 外部模块检查通过。
- 隔离 Electron 检查空库保存、取消、同名文件保护、保存前后库不变；审阅 1280 宽中文浅色与 820 宽英文深色截图，截图位于 `test-results/knowledge-skill/`。

测试只替换隔离实例的原生文件选择返回值，仍执行真实 preload、IPC 和文件落盘。没有修改或导入用户资料库，未发起模型请求。测试实例结束后关闭，保留原有用户进程。
