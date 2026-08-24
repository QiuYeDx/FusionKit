# 工作包 LINK-001 / LINK-007A：字幕翻译安全配置与批次快照

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`LINK-001`、`LINK-007`

## 本次实现内容

- 新增字幕翻译模块自有的安全配置 Store，只持久化源/目标语言、翻译输出模式、切片、输出模式、冲突策略、分片并发和 path-free 目录展示名。
- 在新旧字幕翻译 Store 创建并 hydrate 前执行同一幂等 cross-key bootstrap；写入后做 exact readback，失败时保留全部 legacy key 并让导入协调器 fail closed。
- SubtitleTranslator 页面保持 legacy 行为，同时把当前安全偏好同步到新 Store；不复制 API Key、endpoint、capability/token 或 raw `outputURL`。
- 新增 translator-owned snapshot coordinator，等待 config/model Store hydration 后冻结公开脱敏摘要、私有 model fields、handoff mode 和可选 custom directory lease。
- `enqueue_translation` 在无 profile 时生成显式 `needs_configuration` snapshot；`enqueue_and_start_translation` 无 profile 时返回 `profile_required`。
- snapshot 使用内存 TTL；release 开始即 fence 使用，并发 release 合并。release 失败恢复 snapshot 供重试，释放中的 ID 仍保持占用，custom lease 缺少私有 authority 时 fail closed 并释放。

## 修改文件

- `src/type/generatedSubtitleImport.ts`
- `src/store/tools/subtitle/useSubtitleTranslatorConfigStore.ts`
- `src/store/tools/subtitle/useSubtitleTranslatorConfigStore.test.ts`
- `src/store/tools/subtitle/subtitleTranslatorConfigBootstrap.test.ts`
- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/services/subtitle/generatedSubtitleImportCoordinator.ts`
- `src/services/subtitle/generatedSubtitleImportCoordinator.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`

## 接口或数据结构变化

- 新增 `SubtitleTranslatorConfigPreferences` 与 `useSubtitleTranslatorConfigStore`。
- 新增 `SubtitleTranslationImportConfigSummary`、`PrepareGeneratedSubtitleImportResult` 和 `AutomaticSubtitleTranslationHandoffMode`。
- 新增 `GeneratedSubtitleImportSnapshotCoordinator.prepareBatch()`、`withSnapshot()` 与 `releaseBatch()`。
- 公开 summary 不包含 API Key、model endpoint/model key、真实路径或 capability；这些执行字段只存在于不持久化的私有快照。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/store/tools/subtitle/useSubtitleTranslatorConfigStore.test.ts src/store/tools/subtitle/subtitleTranslatorConfigBootstrap.test.ts src/services/subtitle/generatedSubtitleImportCoordinator.test.ts src/services/subtitle/translatorQueueService.test.ts src/agent/task-model-config.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 聚焦 5 files / 38 tests 通过。
- TypeScript 通过。
- renderer、Electron main、preload 三段 Vite test build 通过；仅有既有 dynamic-import/chunk-size warning。
- `git diff --check` 通过。
- 未启动 Vite/Electron 常驻服务。

## 未完成事项

- 本 checkpoint 不创建 `taskId`、`handoffKey` 或 target handle，也不消费 LINK-006 one-shot import token。
- 未实现 `importArtifact`、main-private candidate factory、immutable receipt 与 exact start。
- 未迁移旧 filename-keyed renderer queue，不调用 `startAllTasks()`。
- `custom` 自动交接仍等待 `LINK-003` translator-owned directory capability；legacy `outputURL` 继续保留且不能作为授权。
- 同会话 bootstrap 失败后，即使重写 target 成功，live Store 仍保持 failed；必须 clean reload 后才解除 readiness fence。

## 下一步建议

- 先完成 `LINK-002` 的稳定 taskId、`ready | needs_configuration` execution binding、批量回执和按 ID 精确启动基础。
- 再完成 `LINK-003` 的目录 capability 与无路径任务引用。
- 随后由 `LINK-007B` 接入 candidate/import receipt/exact start，最后由 `LINK-008` 接通三种后处理模式与 FE-004 手动交接入口。
