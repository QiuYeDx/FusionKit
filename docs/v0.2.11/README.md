# FusionKit v0.2.11 文档入口

> 初始化日期：2026-07-02
> 分支：`v0.2.11`
> 状态：迭代进行中

本目录用于承载 v0.2.11 版本的开发设计、执行计划、实施记录、验收修复和增量需求文档。后续每个独立需求应优先建立自己的主题目录，避免把多个功能的设计、台账和实施记录混在一个文件中。

## 目录约定

```text
docs/v0.2.11/
  README.md
  v0.2.11_iteration_execution_plan.md
  implementation-records/
    README.md
  feat/
    README.md
  fix/
    README.md
  <feature-slug>/
    <feature-slug>_final_design.md
    <feature-slug>_execution_plan.md
    <feature-slug>_implementation_records/
      YYYY-MM-DD_<work-package-id>_<short-title>.md
    feat/
      YYYY-MM-DD_<feature-slug>_<short-title>.md
    fix/
      YYYY-MM-DD_<feature-slug>_<short-title>.md
```

## 使用方式

每次开始 v0.2.11 相关开发前：

1. 阅读本入口文档。
2. 阅读 `v0.2.11_iteration_execution_plan.md`，确认当前版本级台账。
3. 阅读目标需求主题目录下的 final design 和 execution plan。
4. 检查 `git status --short`，保留用户已有改动。
5. 认领一个最小可闭环工作包，再开始编辑。

每次结束 v0.2.11 相关开发前：

1. 运行相关验证，或记录无法运行的原因。
2. 更新对应需求 execution plan 的进度台账。
3. 新增或更新实施记录。
4. 如发现需求变更或验收问题，补充 `feat/` 或 `fix/` 文档。
5. 回答用户前结束本次会话启动的全部前端服务进程。

## 当前主题

| Feature Slug | 状态 | 入口 |
| --- | --- | --- |
| `name-translator-ux` | 已完成 `NT-UX-001` | `docs/v0.2.11/name-translator-ux/name-translator-ux-execution-plan.md` |
| `qiuye-ui-refresh` | 已完成 `QIUYE-UI-001` | `docs/v0.2.11/qiuye-ui-refresh/qiuye-ui-refresh-execution-plan.md` |
| `openai-api-format-compatibility` | 已完成 `PRE-001`、`CORE-001`、`CORE-002`、`BE-001`、`BE-002`、`BE-003`、`BE-004`、`BE-005`、`FE-001`、`FE-002`、`AGENT-001`、`AGENT-002`、`FIX-001`；`DOC-001` 发布说明部分完成，下一步 `QA-001` / 补齐 README 与隐私说明 | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md` |
| `audio-toolkit` | `FIX-001`～`FIX-007`、`AUDIT-001`、`QA-001` 已完成；TypeScript、四语言 i18n、全量 73 files / 560 tests、Vite test build、四路由×四语言×宽窄窗口 Electron 矩阵通过；真实供应商/设备验收保留在 `QA-002` | `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md` |
| `audio-toolkit-config-ux-refactor` | `PRE-R01`～`I18N-R01` 已完成；四工具 standalone 消费、legacy facade 与源码 i18n 门禁闭环，M3 已达成；下一步 `TEST-R01` | `docs/v0.2.11/audio-toolkit/audio-toolkit-config-ux-refactor_execution_plan.md` |

收到新的具体迭代需求后，在本目录下新增 `<feature-slug>/` 并补齐设计文档与执行计划。
