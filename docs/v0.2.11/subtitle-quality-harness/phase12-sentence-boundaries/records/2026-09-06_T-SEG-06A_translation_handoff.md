# T-SEG-06A 导出句界到翻译的结构保持

2026-09-06，基线5d9837b，承接R-SEG-06/07及已完成05T。用户要求提交推送后继续，本子项按设计6.31执行，验证完成前保持进行中。不调用真实翻译API、不把结构占位译文当成质量改进，不重复改动ASR。

## 结果与验收映射

新增`test/translation/local-subtitle-handoff-structure.test.ts`，调用真实本地格式编码、SRT/LRC翻译器分片、JSON响应校验、最终文件落盘；只替换模型传输和Electron事件。公开合成字幕含独立短句、多行、中性空格、真实两次「はい」以及向下取整后相同的LRC标签。双语/仅译文各按1和10000 token预算运行，刻意反序返回完整ID，验证输出仍按原条目排序。10项测试（4项各含两种预算、6项失败路径）通过；原文/时间保持，缺ID、重复ID和伪造时间响应均不生成最终文件。

原有翻译器已使用字幕ID协议和本地时间轴重建，无须另写一套保护。修正LRC翻译器关于“模型输出时间标签”的过时注释；本批未改变其运行行为。生成字幕仍走不可见路径的artifact交接，未引入跨工具共享可变Store。

当前组合回归20文件348项通过：句界/接缝/完整词对应、格式、翻译上下文及协议、导入配置快照、仅启动回执任务、设置清洗等。另补生成字幕候选能力与Store持久化13项通过，共361项。最终TypeScript检查通过。

私有`test-results/phase12-translation-handoff-replay.ts`对05T的opening/full/independent/quiet/control五份SRT+LRC、共10文件作两种模式20次合同重放，全部保持原条目时间/顺序与双语源正文；实际条数为13/67/27/1/3。这里只调用现有解析/重建合同，不冒充又跑了一遍Electron或翻译API。所有占位产物名称带`STRUCTURE-TEST`，目录为`test-results/subtitle-quality-review/phase12/translation-handoff/`，`verification.json`明确`translationQualityEvaluated:false`。原字幕字节及NAS三文件SHA/大小/mtime均保持。

设置静态核对：四语言已有cue_targets_hint，类型cuePolicy为sentence_readable_dtw_v3，后处理schemaVersion为3；已有Store版本3与设置清洗/持久化测试通过，不覆盖旧用户偏好。本项没有新增UI或语言键，不将旧页面验证重述为本轮新截图，也不以测试替代重启应用人工验收。

## 尚未完成

- T-SEG-05：既有无标点/带标点分句、完整词界、引号拒绝、真实重复与跨窗来源均已有对应自动测试；05T六素材原有结果可用于后续综合验收。仍不将多个局部aligned标签等同全轨词义/全部时间正确，T-SEG-07综合人工验收未执行。
- T-SEG-06后续：任务详情尚无最终“保留原段”计数。后处理的segment_boundaries_preserved来自增强前计划；生产执行器只取transcript，随后又可能分句/合并，不能直接展示旧计数。应先建立最终输出的计数口径与限额、严格IPC字段，再加四语言说明和实际Electron界面回归。
- 翻译知识库/术语积累和上下文质量仍属于后续功能，不因本次结构保持而宣称解决。

06A结构验证完成，代码与记录尚未提交。本轮没有启动Electron/Vite/ASR进程或真实模型请求。旧版规格文档沿用，当前需求/依赖/记录链接检查独立保存，不调用不兼容的v2检查器。
