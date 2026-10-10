# 实施记录：T-STRUCTURE-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-STRUCTURE-02 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | ae6579f10bddb829e8d6e6aa81422498ee98facc5b95166707aa3ccd71443004 |

## 实际结果

- 选中工具栏：多选时出现「合并」（不相邻时禁用并说明）；菜单：「编辑时间」（单条，T）、「合并为一条」（Ctrl+M）、「平移时间…」；时间列双击编辑。
- 时间编辑器：开始/结束两个输入框（`HH:MM:SS.mmm` 等格式），Enter 保存、Esc 取消、离开保存；结束早于开始、越过相邻字幕、格式错误、转写必须有结束等就地说明；窄列时两框换行。
- 平移对话框：毫秒数（可负）与预览，越界或为负时禁用；撤销历史标签「合并 N 条字幕」「调整 N 条字幕的时间」；帮助提示新增两行。四语言。
- 初版审查发现时间输入被压缩截断、占位文字被截断 → 固定宽度并改用「未知」占位，复验通过。截图已审阅：screenshots/studio-cue-structure--01..05。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-STRUCTURE-02-1 | 通过 | file:records/final-electron.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-STRUCTURE-01-1 | 通过 | V-STRUCTURE-02-1 |
| AC-STRUCTURE-01-3 | 通过 | V-STRUCTURE-02-1 |
| AC-STRUCTURE-01-4 | 通过 | V-STRUCTURE-02-1 |
| AC-STRUCTURE-02-1 | 通过 | V-STRUCTURE-02-1 |
| AC-STRUCTURE-02-2 | 通过 | V-STRUCTURE-02-1 |
| AC-STRUCTURE-02-3 | 通过 | V-STRUCTURE-02-1 |

## 风险与未执行项

跨页合并不支持（选择限于当前页）。AC-STRUCTURE-02-1 的“导出 SRT 使用新时间”由 T-STRUCTURE-01 单元测试覆盖。
