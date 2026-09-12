# I6：稳定工作区布局与局部全选

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-13 |
| 任务 | T-INTERACTION-04 |
| 验证版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |
| 环境 | Windows x64，Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3 |
| 任务指纹 | 893eff124e2d1b0770436ed9a99ba885fb2eb894238f1bcf7ddfe8f5d0a28cab |

## 实际结果

翻译概览移入文档左侧独立面板，窄窗提供文档工具栏入口；转写页不再显示。工作台面板标题竖直内边距缩至8px，保留操作热区。统一标题与内容起点，修正40px标题栏占位和滚动flex容器约束。已有页面全选直接更新选择；跨页查询仅显示局部pending，迟到结果受选择代次、查询、生命周期与删除观察保护。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-INTERACTION-04-1 | 通过 | inline: workspace实际Electron通过全选无正文重读/全页busy/无关disabled/loading；覆盖跨页局部pending、重复点击、清除/单选、筛选、删除、卸载、101份上限。live-refresh、vertical与library三个既有实际Electron回归各1/1通过。library验证41份导入、2份实际导出与同名防覆盖、批量恢复/取消/删除及101份选择上限；原41份输入均保留。 |
| V-INTERACTION-04-2 | 通过 | inline: test-results/studio-i6-workspace/run-Z3MnOD/result.json及5幅实际截图：1280窗口两视图header top40/content top120，786窗口top40/116严格一致；标题内边距8px，横溢出为0。窄长转写滚动到底时内容bottom440 < navigationTop482。compact弹窗Enter打开及关闭回焦通过。 |
| V-INTERACTION-04-3 | 通过 | inline: 两套生产及受影响测试严格TypeScript、四语言键与源引用、422文件边界、最终renderer/main/preload构建与preload检查通过。相关单元56项与导出守卫30项均通过（两组有7项重叠，不相加）。最终spec/diff及源码快照见综合收尾记录。 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-INTERACTION-07-1 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-07-2 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-08-1 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-08-2 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-09-1 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-09-2 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-10-1 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |
| AC-INTERACTION-10-2 | 通过 | V-INTERACTION-04-1, V-INTERACTION-04-2, V-INTERACTION-04-3 |

## 风险与未执行项

通过真实IPC和仓库验证；仅延迟既有list handler返回以构造竞态，保留权限和生产逻辑。截图为隔离生成字幕，未复用用户真实媒体标题。

用户整体验收仍pending，未代签；本轮未提交推送，I4编辑及打包继续暂停。完整证据与失败后复验过程见[综合收尾记录](2026-09-13-interaction-closeout.md)。
