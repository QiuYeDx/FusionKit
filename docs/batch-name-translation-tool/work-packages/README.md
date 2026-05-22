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
| RN-001 | 已完成 | 类型与 IPC 扫描能力 | 无 | `RN-001_types-and-ipc-scanning.md` |
| RN-002 | 已完成 | 名称翻译 planner | RN-001 | `RN-002_name-translation-planner.md` |
| RN-003 | 已完成 | 安全 apply + journal | RN-001, RN-002 | `RN-003_safe-apply-and-journal.md` |
| RN-004 | 已完成 | 手动工具页 | RN-001, RN-002, RN-003 | `RN-004_manual-tool-page.md` |
| RN-005 | 已完成 | 工具入口与 i18n | RN-004 可并行后半段 | `RN-005_tool-entry-and-i18n.md` |
| RN-006 | 已完成 | HomeAgent 工具 Schema 与执行器 | RN-001, RN-002, RN-003 | `RN-006_homeagent-tools-and-executor.md` |
| RN-007 | 已完成 | HomeAgent 预览确认 UI | RN-006 | `RN-007_homeagent-preview-confirmation-ui.md` |
| RN-008 | 已完成 | 测试与文档回填 | RN-001 至 RN-007 | `RN-008_tests-and-docs.md` |

---

## 实施记录

| ID | 完成日期 | 关键变更 | 验证 | 实施记录 |
| --- | --- | --- | --- | --- |
| RN-001 | 2026-05-19 | 新增 rename 主进程类型、扫描器、IPC 注册和扫描测试 | `pnpm exec vitest run test/rename/scanner.test.ts`；`pnpm build` | `../implementation-records/2026-05-19_RN-001_types-and-ipc-scanning.md` |
| RN-002 | 2026-05-19 | 新增 renderer dry-run planner、plan store、名称清洗、冲突检测和测试 | `pnpm exec vitest run test/rename/scanner.test.ts src/services/rename`；`pnpm build` | `../implementation-records/2026-05-19_RN-002_name-translation-planner.md` |
| RN-003 | 2026-05-19 | 新增 validate/apply/rollback IPC、两阶段 rename、journal 与 renderer apply service | `pnpm exec vitest run test/rename src/services/rename`；`pnpm build` | `../implementation-records/2026-05-19_RN-003_safe-apply-and-journal.md` |
| RN-004 | 2026-05-20 | 新增手动名称翻译工具页、运行时 store、预览编辑、校验、应用与回滚入口 | `pnpm exec vitest run test/rename src/services/rename`；`pnpm exec tsc --noEmit`；`pnpm build`；Electron dev 冒烟 | `../implementation-records/2026-05-20_RN-004_manual-tool-page.md` |
| RN-005 | 2026-05-21 | 新增 `nameTranslator` 工具入口，放开重命名工具卡片，补齐 rename namespace 中英日文案 | `pnpm exec tsc --noEmit`；`pnpm exec vitest run test/rename src/services/rename`；`pnpm build`；`pnpm dev` 启动通过但窗口点击验证受授权限制 | `../implementation-records/2026-05-21_RN-005_tool-entry-and-i18n.md` |
| RN-006 | 2026-05-21 | 新增 HomeAgent rename 工具 schema、执行器、确认判断、pending plan 状态和 prompt 规则 | `pnpm exec vitest run src/agent/tool-schemas.test.ts src/agent/name-plan-confirmation.test.ts src/agent/name-translation-intent.test.ts`；`pnpm exec tsc --noEmit`；`pnpm exec vitest run src/agent src/services/rename test/rename`；`pnpm build` | `../implementation-records/2026-05-21_RN-006_homeagent-tools-and-executor.md` |
| RN-007 | 2026-05-21 | 新增 HomeAgent 名称翻译预览确认 widget、pending 卡片、确认/取消/跳转与 apply 结果展示 | `pnpm exec tsc --noEmit`；`pnpm exec vitest run src/agent src/services/rename test/rename`；`pnpm build`；`pnpm dev` 已启动但 in-app browser 访问 localhost 被策略拒绝 | `../implementation-records/2026-05-21_RN-007_homeagent-preview-confirmation-ui.md` |
| RN-008 | 2026-05-21 | 补齐 rename 测试缺口、修正 retry 测试口径、增加 sandbox E2E skip、回填 final design 与最终实现状态 | `pnpm exec vitest run test/rename src/services/rename src/agent`；`pnpm test`；`pnpm exec tsc --noEmit`；`pnpm build` | `../implementation-records/2026-05-21_RN-008_tests-and-docs.md` |
| Fix-001 | 2026-05-21 | 修复 HomeAgent 点击“在工具页打开”后工具页不读取 `planId`、预览为空的问题 | `pnpm exec tsc --noEmit`；`pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts src/agent src/services/rename test/rename`；`pnpm build` | `../implementation-records/2026-05-21_homeagent-tool-page-plan-hydration-fix.md` |

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
