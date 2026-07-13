# 工作包 CORE-R01：独立音频 API Store 与 legacy migration

## 基本信息

- 日期：2026-07-13
- 状态：已完成
- 对应执行计划工作包：`CORE-R01`

## 本次实现内容

- 新增独立 `fusionkit-audio-settings` v1 Zustand Store，保存 `AudioApiProfile[]`、四任务 assignment 与确定性的 migration 状态。
- 实现音频 API 完整 draft CRUD、首条 Profile 对兼容且未分配任务的自动 assignment、交互 assignment 能力校验、显式替换/清空、被引用 Profile 删除拒绝和 route verification 更新。
- 实现 v4/v5 `fusionkit-model` raw envelope 到独立 Store 的纯迁移：复制连接凭证、canonicalize Base URL、迁移 OpenAI/MiMo/Realtime routes、补齐 MiMo 三模式、保留 deprecated Realtime fallback 与不可用旧 assignment。
- 缺失 connection、空白凭证、未知 transport、自定义 MiMo model、重复 legacy ID 或不兼容 assignment 不静默丢弃，保留 Profile 并标记 `needsAttention`。
- 合并已有 target 时保留手工 Profile 和非空 assignment；稳定处理手工 ID 冲突、重复 source ID，并以 `migration.sourceId` 保证幂等。
- 在 `useModelStore` 与 `useAudioApiStore` 的 `create(persist(...))` 前运行同一 bootstrap，避免旧 hydration 先过滤悬空 connection。
- bootstrap 严格校验 source/target；Storage 读取、写入或回读失败不报告完成；只有完整序列化内容精确回读且 marker 合法后才返回 migrated。
- 保留 `fusionkit-model` 中旧 audio 字段、actions 与 runtime consumers 作为切换期兼容层，不从新 Store 双写旧数据。
- 加固旧 `modelConfig` 一次性迁移：目标精确写入并回读后才删除源 key，读取、解析、写入、回读或删除异常均保留源数据。
- 新增项目坑位 `FK-PIT-0006`，固定“跨 key Zustand bootstrap 必须先于两个 Store hydration”的复用规则。

## 修改文件

- `src/lib/audio-api-migration.ts`
- `src/lib/audio-api-migration.test.ts`
- `src/store/useAudioApiStore.ts`
- `src/store/useAudioApiStore.test.ts`
- `src/store/audioStoreBootstrap.test.ts`
- `src/store/useModelStore.ts`
- `src/store/useModelStore.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/run-cross-key-zustand-migrations-before-hydration.md`
- 本需求 Final Design、Execution Plan、版本 README 与版本级台账

## 接口或数据结构变化

- 新持久化 key：`fusionkit-audio-settings`，版本 `1`。
- migration 状态为 `legacyModelStore.status: "not_needed" | "completed"`；完成时记录 `sourceVersion: 4 | 5`，不写时间戳，保证输出确定。
- bootstrap 结果区分 `migrated`、`already_complete`、`no_source`、`no_storage` 与失败原因；失败不会删除或修改 legacy source。
- `AudioApiProfileDraft` 更新采用 routes 整体替换；完整保存会保留 legacy provenance 并清除 `needsAttention`。
- 旧 `useModelStore` audio 字段/actions 暂时保留并标记 deprecated；独立 Store 不引用 `connectionProfileId`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/audio-api-migration.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts test/audio/audioApiMigrationFixtures.test.ts src/store/useModelStore.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/tools/audio src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/lib/audio-provider-registry.test.ts src/lib/audio-api-migration.test.ts src/store/useModelStore.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
```

结果：

- CORE 定向验证通过：5 files / 46 tests。
- PRE + CORE + 旧音频回归合并矩阵通过：24 files / 168 tests。
- TypeScript 检查通过。
- i18n 检查通过：9 namespaces，四语言各 1420 keys；仅有 9 个既存同值 warning。
- `git diff --check` 通过。
- 未运行 pnpm，`pnpm-lock.yaml` 未修改。
- 未启动 Vite、Electron 或其他前端服务。

## 审计修复

- 拒绝会在 normalization 中丢 Profile、重复 canonical ID、assignment 或 migration 状态的结构损坏 target，原始 target 保持不变。
- 拒绝关键容器或 legacy audio item 结构损坏的 source，不写 completed marker。
- duplicate source ID 先预留整批真实 ID，再生成稳定 synthetic ID，避免合成 ID 吞掉真实 Profile。
- 写后回读比较完整序列化字符串，不能只凭 completed marker 判断成功。
- 空白 API Key/Base URL 也标记 `needsAttention`。
- 文本 CRUD 与音频 CRUD 均有反向持久化 key 隔离测试；legacy backup 仍留在 `fusionkit-model`。
- 不兼容 assignment replacement 在写入前原子拒绝；完成修复保存后可清除 `needsAttention`。

## 未完成事项

- 当前设置页、main runtime 和四个音频工具仍消费 legacy facade；migration completion 后不再吸收旧 UI 的新增写入，因此 `CORE-R01` 不得作为独立发布边界。
- `FE-R01` 必须停止设置页写 legacy audio；`BE-R01`、`FE-R02`、`FE-R03` 必须完成消费者切换；最后由 `FE-R03` 删除旧 audio CRUD/selectors 和文本 Profile 的 connection 删除保护。
- legacy audio 字段至少保留一个版本作为只读备份；不得恢复新旧 Store 双写。
- Zustand action 沿用项目现有 persist 失败语义；本工作包只对数据迁移路径实现写后回读与可重试保护。

## 下一步建议

- 下一会话认领 `BE-R01`：把 runtime snapshot 改为 standalone audio profiles，新增 provider-neutral speech intent 与 main `resolveRoute`，继续保留 sender/revision、文件 token、输出 token 和取消安全边界。
- `BE-R01` 实施时不得提前删除 legacy facade；与 `FE-R01`～`FE-R03` 完整切换后再统一移除最后消费者和删除 guard。
