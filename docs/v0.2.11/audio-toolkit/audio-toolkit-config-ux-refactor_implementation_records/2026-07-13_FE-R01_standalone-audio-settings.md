# 工作包 FE-R01：独立音频设置与首次配置链路

## 基本信息

- 日期：2026-07-13
- 状态：已完成
- 对应执行计划工作包：`FE-R01`

## 本次实现内容

- 设置页新增独立“音频”tab，由 `tab` search param 直接驱动；同 pathname 下只改变
  query 也能可靠切换内容。`returnTo` 只允许四条精确音频工具路径。
- `ModelConfig` 停止挂载 legacy `AudioModelConfig`，设置页不再写 legacy audio；旧
  组件与 Store facade 保留到 `FE-R03` 最后消费者迁移后清理。
- 新增独立音频 API 页面：四任务默认 assignment、API 列表、provider/route/
  verification/使用状态，以及基于 `ScrollableDialog` 的新建、编辑和使用中删除。
- OpenAI、MiMo 使用 provider registry 默认 routes；自定义兼容 API 显式开启任务
  route 并填写 model。跨供应商切换清空旧 API Key，API 列表不展示 Key 片段。
- 第一条 API 自动分配所有兼容且尚未分配的任务，并通过持久 Alert 列出结果；撤销
  使用 compare-and-clear，不覆盖用户随后手选的 assignment。
- 编辑 routes 时原子清理不再兼容的 assignment；保存并返回仍通过全局反馈列出清理
  任务。删除使用中 API 时逐任务选择兼容替代或取消分配，校验完成后一次提交。
- 代理入口在存在未保存表单时先确认；普通“保存”留在设置页，“保存并返回”才回到
  白名单内的来源工具。
- 四语言补齐设置文案；Electron E2E 使用临时 userData 覆盖首次 MiMo 配置、自动
  分配撤销/重分配、跨供应商清 Key、route 收缩、返回反馈和宽窄窗口视觉边界。
- 新增 `FK-PIT-0008`，记录 pathname-keyed route 下 query tab 必须由 search params
  持续驱动的项目规则。

## 修改文件

- 设置页与表单：`src/pages/Setting/index.tsx`、
  `src/pages/Setting/settingNavigation.ts`、
  `src/pages/Setting/components/ModelConfig.tsx`、
  `src/pages/Setting/components/AudioApiConfig.tsx`、
  `src/pages/Setting/components/audioApiConfigModel.ts`。
- Store：`src/store/useAudioApiStore.ts`。
- 测试：`src/pages/Setting/settingNavigation.test.ts`、
  `src/pages/Setting/components/audioApiConfigModel.test.ts`、
  `src/store/useAudioApiStore.test.ts`、`test/e2e.spec.ts`。
- i18n：`src/locales/{zh,zh-Hant,en,ja}/setting.json`。
- 项目经验：`.agents/skills/fusionkit-pitfall-guard/references/`。

## 接口或数据结构变化

- 设置导航新增 `SettingTabKey = "audio"`、`AudioToolReturnPath` 精确白名单及
  `createSettingSearchParams()` 纯函数；未新增 `/setting/audio` 路由。
- `useAudioApiStore` 新增 `undoAutoAssignments(profileId, keys)`，只清理仍指向目标
  profile 的任务。
- 新增 `updateProfileWithResult()`，返回 `clearedAssignmentKeys`；原 `updateProfile`
  boolean 合同保持兼容。
- 新增 `removeProfileWithAssignments()`，逐任务 replacement map 全量校验后原子更新
  assignment 并删除 profile；失败不产生部分写入。
- 音频 API 表单切换到不同 provider preset 时清空 API Key 并重建 endpoint/routes；
  重复选择当前 preset 是 no-op。
- 本工作包未改变 Electron IPC 或 renderer task payload 合同。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Setting/components/audioApiConfigModel.test.ts src/pages/Setting/settingNavigation.test.ts src/store/useAudioApiStore.test.ts --reporter=verbose
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/tools/audio src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/lib/audio-provider-registry.test.ts src/lib/audio-api-migration.test.ts src/store/useModelStore.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts src/services/audio/audioServices.test.ts src/pages/Setting/settingNavigation.test.ts src/pages/Setting/components/audioApiConfigModel.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts --reporter=verbose
node_modules/.bin/vitest run
git diff --check
ps -axo pid,ppid,command | rg '<FusionKit Vite/Electron process patterns>'
```

结果：

- 设置导航、表单与 Store：3 files / 27 tests 通过。
- 扩展音频矩阵：31 files / 261 tests 通过。
- 全量 Vitest：85 files / 709 tests 通过，其中 Electron E2E 3 tests 通过。
- E2E 覆盖第一条 MiMo API 自动分配、撤销、重新分配、跨供应商清 Key、自定义
  route 收缩、assignment 原子清理、保存返回反馈，以及 4 路由 × 4 语言 × 2 尺寸。
- 1280×800 设置页和 786×540 对话框截图已审查：preload loading 已退出，footer
  固定可达，中间内容可滚动，无页面或 ScrollArea 横向溢出。
- TypeScript 通过；i18n 四语言各 1505 keys 对齐，只有 9 条既有 same-as-source
  提示；Vite test build 通过，只有既有 dynamic-import/chunk-size warning。
- `git diff --check` 通过；未运行 pnpm，`package.json`、`pnpm-lock.yaml` 未改。
- 两轮 Electron 验证和最终全量测试后均检查进程表，无 FusionKit Vite/Electron
  残留进程。

## 未完成事项

- `FE-R02` 尚未升级 TTS store/UI；三模式条件渲染、配置 CTA 和 voice-clone
  token 提交链路仍待完成。
- `FE-R03` 尚未迁移 ASR、实时字幕、双向语音消费者；legacy audio CRUD/selectors、
  `AudioModelConfig` 与文本 connection 删除保护在最后消费者切换前继续保留。
- `I18N-R01` 的源码 key 使用检查、`TEST-R01`/`QA-R01` 完整自动化门禁和
  `QA-R02` 真实供应商/设备验收仍按计划后续执行。

## 下一步建议

- 下一会话认领 `FE-R02`：以独立 assignment/route 为唯一配置来源升级 TTS store
  v4，按 provider/mode 条件渲染字段，完成 provider-neutral intent、配置 CTA 与
  voice sample 选择即授权链路。
- 保持 renderer 不提交 API Key、Base URL、transport 或 model；继续复用
  `BE-R01` 的可信 route resolver 和一次性 token 边界。
