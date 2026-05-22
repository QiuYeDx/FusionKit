# 工作包 RN-007：HomeAgent 预览确认 UI

## 基本信息

- 日期：2026-05-21
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-007_homeagent-preview-confirmation-ui.md`

## 本次实现内容

- 新增 HomeAgent 名称翻译预览 widget：展示 plan 短 id、总数、可应用/冲突/跳过/无变化统计、preview 项、warning 和错误状态。
- `create_name_translation_plan` tool result 不再只显示 JSON，而是转换为 `qv:name-translation-plan` 专用卡片。
- pending rename plan 在 HomeAgent 消息流底部展示确认卡，支持确认应用、取消和打开工具页。
- “在工具页打开”现在带 `planId` 跳转，并由工具页自动从 memory plan store 恢复完整预览、选中路径和配置。
- 确认按钮复用 `confirmNameTranslationPlan(planId)`，blocked 或不可应用计划禁用确认；大批量或带 warning 的计划会二次确认。
- 新增 apply result widget，展示成功/失败/跳过数量与 `journalId`。

## 修改文件

- `src/pages/HomeAgent/components/NameTranslationPlanWidget.tsx`
- `src/pages/HomeAgent/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/store/agent/useAgentStore.ts`
- `src/agent/types.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-007_homeagent-preview-confirmation-ui.md`

## 接口或数据结构变化

- `PendingNameTranslationPlan` 新增 `isApplying?: boolean`，用于 UI 禁用确认按钮和展示进行中状态。
- HomeAgent widget registry 新增：
  - `nameTranslationPlanWidget`
  - `nameTranslationApplyResultWidget`

## 验证结果

执行命令：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run src/agent src/services/rename test/rename
pnpm build
pnpm dev
```

结果：

- TypeScript 检查通过。
- Agent 与 rename 回归通过，11 个测试文件、61 个断言通过。
- 生产构建与 Electron 打包通过；保留既有 chunk size、动态导入和未签名提示。
- `pnpm dev` 启动成功，Vite 本地地址为 `http://localhost:5173/`。
- in-app browser 访问 `http://localhost:5173/` 被环境策略拒绝，本轮未完成视觉冒烟；没有绕过该限制。

## 未完成事项

- 真实 HomeAgent 对话的端到端人工验证仍需要在允许访问本地 dev server 的环境中执行。

## 下一步建议

- 开始 RN-008，补齐文档回归、E2E/人工验收清单，并覆盖工具页按 `planId` 恢复当前 plan 的手工路径。
