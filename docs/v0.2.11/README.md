# FusionKit v0.2.11 文档入口

> 初始化日期：2026-07-02
> 分支：`v0.2.11`
> 状态：迭代准备中

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

收到新的具体迭代需求后，在本目录下新增 `<feature-slug>/` 并补齐设计文档与执行计划。
