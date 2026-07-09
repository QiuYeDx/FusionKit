# 工作包 CORE-001：全局音频 profile、assignment 与 store migration

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`CORE-001`

## 本次实现内容

- 新增 `src/lib/audio-profile.ts`，集中处理 audio profile normalization、持久化迁移、assignment 清理、connection profile 引用检测和 assignment eligibility。
- 将 `fusionkit-model` persist 版本从 v3 升到 v4，新增 `audioProfiles` 与 `audioAssignment` 持久化字段。
- 新增 audio profile CRUD action、audio assignment action、按 assignment 解析 runtime config 的 store helper。
- 删除 connection profile 时，如果仍被 audio profile 引用，store 会阻止删除，避免产生悬空 audio profile。
- 删除 audio profile 时，会自动清理所有引用该 audio profile 的 audio assignment。
- 补齐 `src/lib/audio-profile.test.ts` 与 `src/store/useModelStore.test.ts`，覆盖迁移、引用过滤、assignment guard、runtime config 解析和删除保护。

## 修改文件

- `src/lib/audio-profile.ts`
- `src/lib/audio-profile.test.ts`
- `src/store/useModelStore.ts`
- `src/store/useModelStore.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`

## 接口或数据结构变化

- `fusionkit-model` persist version：`3` -> `4`。
- 新增持久化字段：
  - `audioProfiles: AudioModelProfile[]`
  - `audioAssignment: AudioModelAssignment`
- 新增 store actions/helper：
  - `addAudioProfile()`
  - `updateAudioProfile()`
  - `removeAudioProfile()`
  - `getAudioProfileById()`
  - `setAudioAssignment()`
  - `getAudioProfileForAssignment()`
  - `getAudioRuntimeConfigForAssignment()`
  - `isConnectionProfileReferencedByAudioProfile()`
- 新增导出迁移函数：`migrateModelConfigToV4()`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/store/useModelStore.test.ts src/lib/audio-profile.test.ts test/audio src/type/audioIpc.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run src/store/useModelStore.test.ts src/lib/audio-profile.test.ts test/audio src/type/audioIpc.test.ts` 通过，5 个测试文件 / 28 个测试。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过。
- 本次未启动 Vite、Electron 或其他前端服务。

## 未完成事项

- 设置页 UI 尚未接入 audio profile CRUD 和 deletion warning。
- `CORE-002` 的 endpoint/file/output/stream 基础工具尚未开始。

## 下一步建议

- 下一步认领 `CORE-002`，实现 `normalizeAudioEndpoint()`、音频 MIME/扩展名映射、上传大小限制、输出文件命名、PCM16 chunk 写入和 WAV header 包装。
