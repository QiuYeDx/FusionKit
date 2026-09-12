# I6：导出检查、确认与结果步骤

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-13 |
| 任务 | T-INTERACTION-03 |
| 验证版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |
| 环境 | Windows x64，Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3 |
| 任务指纹 | 64272fe81f07e2ef2644ff370854c9e3f62d0e64589e365506cc1679515b37e0 |

## 实际结果

导出分为设置、确认导出、结果三个明确步骤，切换标题、焦点和内容区。已选文档位于编码与换行之前。确认页只展示就绪及输出摘要、合并格式变化；文件级详情默认折叠。确认按钮提交实际检查计划中的接受项，返回设置清除旧计划；部分/全部受阻、取消和过期保护保留。导出和原始下载结果采用统一简洁组件，全部失败不显示绿色成功0。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-INTERACTION-03-1 | 通过 | inline: 新interaction-export-ui 1/1通过14.83s；真实取消保留review、返回设置清旧plan、主进程时钟推进16分钟后过期拒绝、0就绪禁用、2就绪1阻断及输出4条、单份/批量实际写入、原始字节下载和3份全失败反例均通过。旧export、acceptance-files、experience-export三套各1/1通过，覆盖VTT/ASS、冻结修订、格式接受项、来源恢复、零/单/多轨与8份批量输出，源hash均不变。 |
| V-INTERACTION-03-2 | 通过 | inline: 最终test-results/studio-i6-export/run-cMYu0E/result.json及10图，连同另外3套合计32张实际截图已审阅。所有新场景横溢出0，footer在视口内；编号与名称glyph bottom同为566.75px，操作32px。部分及全部失败默认无逐行清单，展开入口保留；原生窗口1280×860与786×540。 |
| V-INTERACTION-03-3 | 通过 | inline: 两套生产及受影响测试严格TypeScript、四语言键与源引用、422文件边界、最终renderer/main/preload构建与preload检查通过。相关单元56项与导出守卫30项均通过（两组有7项重叠，不相加）。最终spec/diff及源码快照见综合收尾记录。 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-INTERACTION-04-1 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |
| AC-INTERACTION-04-2 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |
| AC-INTERACTION-05-1 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |
| AC-INTERACTION-05-2 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |
| AC-INTERACTION-06-1 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |
| AC-INTERACTION-06-2 | 通过 | V-INTERACTION-03-1, V-INTERACTION-03-2, V-INTERACTION-03-3 |

## 风险与未执行项

真实main/preload/repository/source/export流程在隔离目录执行，所有输入哈希验证不变；失效和全部失败反例只操作测试自有时钟或输入并在finally恢复。未发布或触碰真实用户字幕/媒体。

用户整体验收仍pending，未代签；本轮未提交推送，I4编辑及打包继续暂停。完整证据与失败后复验过程见[综合收尾记录](2026-09-13-interaction-closeout.md)。
