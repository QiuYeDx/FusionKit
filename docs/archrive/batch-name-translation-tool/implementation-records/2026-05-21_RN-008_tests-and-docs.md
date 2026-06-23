# 工作包 RN-008：测试与文档回填

## 基本信息

- 日期：2026-05-21
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-008_tests-and-docs.md`

## 本次实现内容

- 对照 RN-008 清单补充关键测试覆盖：
  - scanner：目录 self、children directories。
  - planner：显式 `path_segments` 当前延后、unsafe path segment 起点。
  - apply：独立目录 rename + rollback。
- 修正字幕翻译队列 retry 测试口径，使其符合当前 failure recovery 设计：默认 `resume` 保留进度，`restart` 清空 recovery 与进度。
- 调整 Electron E2E：在 Linux、Codex seatbelt sandbox 或 `FUSIONKIT_SKIP_E2E=1` 时显式跳过，并给 `afterAll` 增加 page/app 存在性守卫。
- final design 增加 RN-008 实现回填，记录最终 IPC、最终路由、plan store TTL、`path_segments` 延后、journal/rollback 限制与 HomeAgent widget。
- 新增最终实现状态说明，集中记录实现范围、偏差、限制和后续建议。

## 修改文件

- `test/rename/scanner.test.ts`
- `test/rename/apply.test.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `src/services/subtitle/translatorQueueService.test.ts`
- `test/e2e.spec.ts`
- `docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`
- `docs/batch-name-translation-tool/implementation-notes/2026-05-21_final-implementation-status.md`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-008_tests-and-docs.md`

## 接口或数据结构变化

- 无生产接口变化。
- 测试环境新增 E2E 跳过条件：
  - `process.platform === "linux"`
  - `CODEX_SANDBOX=seatbelt`
  - `FUSIONKIT_SKIP_E2E=1`

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename src/services/rename src/agent
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

结果：

- rename/agent 定向回归通过：11 个测试文件、66 个断言通过。
- 完整测试通过：16 个测试文件、97 个测试通过。
- TypeScript 检查通过。
- 生产构建与 Electron 打包通过；保留既有 chunk size、动态导入和未签名提示。

## 未完成事项

- HomeAgent 真实视觉冒烟仍受当前 in-app browser localhost 访问策略限制；RN-007 已记录该限制。
- `path_segments` 仍为延后能力，不生成可应用 plan。

## 下一步建议

- 发布前在允许 Electron/localhost UI 的环境中补一次手工验收：手动工具 apply/rollback、HomeAgent plan card confirm/dismiss。
- 后续增强进入 Phase 4 的 `path_segments`，并补更完整的视觉冒烟环境。
