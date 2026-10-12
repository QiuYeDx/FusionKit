# 全量回归（2026-10-12）

版本：`5cf4dba` + 本会话未提交改动（I1 最终工作树）。Windows 11，Node，Vitest，Electron 静默测试窗口（`FUSIONKIT_TEST_WINDOW=quiet`）。

## `pnpm test`（含 pretest 构建）

`Test Files 9 failed | 394 passed | 88 skipped (491)`。失败文件逐一单独复跑：

| 文件 | 单独复跑 | 结论 |
| --- | --- | --- |
| test/local-subtitle/mediaNormalizer.test.ts | 47 通过 | 全量负载下的超时（既有已知现象） |
| test/local-subtitle/modelManagerIpc.test.ts | 5 通过 | 同上 |
| test/local-subtitle/serverSupervisor.test.ts | 56 通过 | 同上 |
| test/subtitle-studio/consistency.test.ts | 9 通过 | 同上 |
| test/subtitle-studio/transcription-task-service.test.ts | 42 通过 | 同上 |
| test/subtitle-studio-provenance/windows-addon-copy.test.ts、replay.test.ts、transcript-executor-replay.test.ts | 初次复跑失败：`Changed audited composition source: electron/main/index.ts / electron/preload/index.ts` | **本次引起**：两个组合入口文件改动后需登记审核。已按既有惯例在 `resources/speech-resources/provenance/current-integration-audits.v1.json` 与 `scripts/subtitle-studio-provenance/current-composition-audits.json` 追加 2026-10-12 审核说明并更新 `currentBlobOid`；复跑 `test/subtitle-studio-provenance/` 16 文件通过、2 跳过（233 通过） |
| test/projectMetadata.test.ts | 2 失败：README 不再包含「## 0.4.0 开发版本亮点」与 Electron 版本表 | **既有**：README 于 `5cf4dba` 重写，与本次无关，未改动 |

结论：除 `projectMetadata` 的既有失败外，没有新增失败。
