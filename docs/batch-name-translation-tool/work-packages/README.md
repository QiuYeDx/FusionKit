# 批量名称翻译工具工作包实施索引

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 创建日期：2026-05-19  
> 用途：为后续开发会话提供逐包实施入口、依赖顺序、验收口径和状态台账。

---

## 使用方式

每次开发前先读最终设计文档，再读本索引和准备认领的工作包文档。实现时只认领一个最小可闭环工作包，除非相邻工作包存在强耦合且可以在一个会话内完整验证。

状态值统一使用：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

---

## 工作包顺序

| ID | 状态 | 标题 | 依赖 | 实施文档 |
| --- | --- | --- | --- | --- |
| RN-001 | 未开始 | 类型与 IPC 扫描能力 | 无 | `RN-001_types-and-ipc-scanning.md` |
| RN-002 | 未开始 | 名称翻译 planner | RN-001 | `RN-002_name-translation-planner.md` |
| RN-003 | 未开始 | 安全 apply + journal | RN-001, RN-002 | `RN-003_safe-apply-and-journal.md` |
| RN-004 | 未开始 | 手动工具页 | RN-001, RN-002, RN-003 | `RN-004_manual-tool-page.md` |
| RN-005 | 未开始 | 工具入口与 i18n | RN-004 可并行后半段 | `RN-005_tool-entry-and-i18n.md` |
| RN-006 | 未开始 | HomeAgent 工具 Schema 与执行器 | RN-001, RN-002, RN-003 | `RN-006_homeagent-tools-and-executor.md` |
| RN-007 | 未开始 | HomeAgent 预览确认 UI | RN-006 | `RN-007_homeagent-preview-confirmation-ui.md` |
| RN-008 | 未开始 | 测试与文档回填 | RN-001 至 RN-007 | `RN-008_tests-and-docs.md` |

---

## 推荐实施路线

1. 先完成 RN-001，建立主进程文件系统能力和共享类型。
2. 完成 RN-002，形成可 dry-run 的 plan 生成链路。
3. 完成 RN-003，让 plan 可以安全 apply 并写 journal。
4. 完成 RN-004 和 RN-005，手动工具先可用。
5. 完成 RN-006 和 RN-007，再接入 HomeAgent，避免 Agent 先接入一个不可人工验证的危险写操作。
6. 最后完成 RN-008，补齐测试、文档和发布前回归。

---

## 全局不变量

1. 名称翻译必须先生成 dry-run plan，不能直接重命名。
2. 默认不递归、不覆盖、不改上级路径、不改扩展名、不处理隐藏项。
3. `path_segments` 必须明确起止层级。
4. HomeAgent 的 `auto_execute` 只能自动生成预览，不能自动应用重命名。
5. 批量 rename 必须写 journal，失败时保留可诊断信息。
6. 大批量结果必须通过 `planId` 引用，不把完整清单塞进 Agent 上下文。

