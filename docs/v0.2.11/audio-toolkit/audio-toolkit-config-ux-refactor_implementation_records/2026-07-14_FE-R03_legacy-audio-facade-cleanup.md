# 工作包 FE-R03：Legacy audio facade cleanup

## 基本信息

- 日期：2026-07-14
- 状态：已完成
- 对应执行计划工作包：`FE-R03`

## 本次实现内容

- `AudioToolShell` 删除 `useModelStore` fallback，只接受工具页必传的 standalone
  config summary 和精确音频设置路径。
- 四个音频工具删除旧 `assignmentKey/configSummaryOverride` 接口，显式传入各自
  route-aware summary。
- `audioToolConfig.ts` 删除 legacy profile/connection resolver、selector、旧状态和摘要
  字段，仅保留 standalone route summary 与 MiMo voice presets。
- `useModelStore` 删除 legacy audio CRUD、assignment selector、runtime resolver 与迁移
  完成后的永久文本 profile 删除保护。
- 保留 `audioProfiles/audioAssignment` 一个兼容版本的只读持久化备份；migration 不再按
  文本 connection id 过滤旧 audio profile，文本 profile 删除不会破坏迁移源。
- 若启动时 bootstrap 失败，被 legacy audio 引用的文本 profile 在本会话返回 `false` 并
  保留 connection 凭证；提示重启后，由下一次 pre-hydration bootstrap 完成迁移，live
  Audio Store 从已验证 target hydration 后才放行删除。
- 删除无生产消费者的 legacy audio profile helper，并把迁移 normalizer 收为模块内部。
- 删除未挂载的 `AudioModelConfig.tsx`，`ModelConfig` 不再把 legacy audio 引用计入文本
  profile 的使用中或删除条件。

## 修改文件

- `src/store/useModelStore.ts`
- `src/store/useModelStore.test.ts`
- `src/lib/audio-profile.ts`
- `src/lib/audio-profile.test.ts`
- `src/pages/Setting/components/ModelConfig.tsx`
- `src/pages/Setting/components/AudioModelConfig.tsx`（删除）
- `src/locales/*/setting.json`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- 四个音频工具 `index.tsx`
- `src/store/tools/audio/audioToolConfig.ts`
- `src/store/tools/audio/audioToolConfig.test.ts`

## 接口或数据结构变化

- `ModelStore` 不再暴露 `add/update/removeAudioProfile`、audio assignment setter/selector、
  legacy runtime config resolver 或 connection reference selector。
- 文本 `removeProfile()` 返回成功布尔值；若当前模块的 pre-hydration bootstrap 未完成，
  则本会话拒绝删除仍被旧 audio profile 引用的 connection。
- `ModelStore.audioProfiles/audioAssignment` 标记为 deprecated read-only migration backup，
  继续由 `partialize` 写回原 Store key，不与 `useAudioApiStore` 双写。
- `AudioToolShell` 的 `configSummary` 与 `settingsPath` 改为必传，删除 `assignmentKey`。
- 删除 `resolveAudioToolConfigSummary()` 与 `createAudioToolConfigSummarySelector()`；
  standalone resolver/selector 保持不变。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/audio-profile.test.ts src/lib/audio-api-migration.test.ts src/store/audioStoreBootstrap.test.ts src/store/useModelStore.test.ts src/store/tools/audio/audioToolConfig.test.ts src/pages/Setting/components/audioApiConfigModel.test.ts src/pages/Setting/settingNavigation.test.ts --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware (speech synthesis|audio transcription|realtime captions|realtime voice)' --reporter=dot
git diff --check
```

结果：

- Cleanup 聚焦 7 files / 51 tests 通过。
- 全量非 Electron 88 files / 807 tests 通过；删除的测试只覆盖已移除 legacy facade。
- 新增“启动 bootstrap 写入失败 -> 当前会话删除被拒绝 -> clean reload 重试成功 -> live
  Audio Store hydration -> 后续 Store 写入仍保留凭证 -> 删除放行”覆盖。
- TypeScript 与 Vite renderer/main/preload test build 通过；构建仅有既有 dynamic import 与
  chunk-size warning。
- Electron route-aware 4 tests 通过，3 tests 因名称过滤跳过；覆盖四个 standalone 工具。
- 未运行 pnpm，`package.json` 与 `pnpm-lock.yaml` 未修改。
- Electron/fake server 由 E2E `afterAll` 关闭；结束前再次检查项目进程表。

## 未完成事项

- `I18N-R01`、`TEST-R01`、`QA-R01`、`QA-R02` 与 `DOC-R01` 保持独立工作包。
- 真实供应商、真实麦克风与扬声器验收未执行。

## 下一步建议

- 进入 `I18N-R01`：清理 legacy audio 文案和未使用 key，增加源码 key usage checker。
- 保持 `fusionkit-model` 中 legacy audio 字段只读一个兼容版本，再由发布迁移计划决定删除。
