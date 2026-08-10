# 工作包 FIX-LIFECYCLE-001：路由稳定运行时与增量文件草稿

## 基本信息

- 日期：2026-08-10
- 状态：已完成
- 对应执行计划工作包：`CORE-004` / `FE-002` / `FE-003` 手工验收修复 checkpoint
- 目标平台：共享 Electron renderer session；本轮不声明 packaged Windows/macOS 产品验收

## 本次实现内容

- 复现并定位路由返回导致 `limit_exceeded` 的生命周期冲突：详情页 mount 自动调用的
  `probeRuntime` 和后续 `previewBackend` 与 committed task 的媒体准备共用同一 owner 的单
  native media operation ticket。
- 新增 `LocalSubtitleEnvironmentService`，把 runtime/resource 环境快照和 backend preview
  cache 从页面局部 state 提升为 SPA session singleton，并以 `useSyncExternalStore` 发布。
- renderer app 初始化时幂等启动共享 task/resource session observer，并静默执行一次
  environment check；页面 mount/unmount 不再发起或取消这些会话级工作。
- 成功 backend preview 以 exact runtime generation、model ID 和 device preference 为 key
  跨路由复用；存在 active task 时禁止发起新的 preview。
- active task 期间的手动刷新只执行 revision snapshot 和 managed resource list，不进入
  media runtime probe；任务空闲时仍保留显式 fresh runtime/resource recheck。
- Store 新增 `addDraftInputFiles()`，把后续授权追加到既有 draft，保持选择顺序、opaque
  token 去重和100文件上限；溢出授权继续进入 bounded capability cleanup retry。
- 文件选择器按实时剩余容量授权，避免已满时产生不必要的新 draft token。
- 新增 `FK-PIT-0086`，明确 route preflight 不得与 committed media work 共享可见导航
  生命周期，也不得通过放宽 native 并发上限掩盖冲突。

## 修改文件

- `src/main.tsx`
- `src/services/local-subtitle/localSubtitleEnvironmentService.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{index.tsx,localSubtitleTranscriberModel.ts}`
- `src/store/tools/subtitle/useLocalSubtitleTranscriberStore.ts`
- 对应 environment service、page/model 与 Store tests
- Final Design、Execution Plan、focused fix doc、本实施记录
- `.agents/skills/fusionkit-pitfall-guard/references/{index.md,keep-route-preflight-out-of-active-media-admission.md}`

## 接口、状态或数据结构变化

- 无新增/修改 Electron IPC channel、公开 schema、preload API、main Job Manager 状态机或
  persisted Store version。
- 新增 renderer-only app session service 与 Store action；environment/backend cache 不持久化，
  不包含路径、token、字幕正文或 main proof。
- draft capability → task lease 原子转移合同不变；route cleanup 仍只回收未提交 draft。

## 安全与生命周期检查

- 保持 `maxConcurrentOperationsPerOwner` 不变；没有让 probe/preview 绕过 main identity 或
  放宽 media admission。
- backend preview cache key 绑定 runtime generation、model 和 device preference；资源变化与
  显式刷新会失效，旧 in-flight response 受 epoch 与页面 generation 双重阻止写回。
- 文件追加仅合并 main 已授权的 opaque token；达到上限的新 token 在从 renderer state
  丢弃前交给既有 cleanup retry。
- app 初始化只读取 runtime/resource 状态，不下载资源、不加载模型、不启动推理 server。

## 验证结果

执行命令：

```text
vitest run localSubtitleEnvironmentService.test.ts useLocalSubtitleTranscriberStore.test.ts localSubtitleTranscriberModel.test.ts localSubtitleTranscriberPage.test.ts
tsc --noEmit --pretty false
vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber src/store/tools/subtitle src/services/local-subtitle test/local-subtitle
vite build --mode test
git diff --check
```

结果：

- 聚焦回归：4 files / 31 tests passed。
- TypeScript 全量检查通过。
- renderer、Electron main、preload 三段 root Vite test build 通过；仅有既有 dynamic import 与
  chunk-size warning。
- 扩大本地字幕回归：67 files / 1183 tests passed，4 files / 6 tests按真实资源条件 skipped；
  本次涉及的 runtime IPC、Job Manager、Media Normalizer、Renderer、Store 与 Service 均通过。
- 扩大回归另有8个既有环境/时序失败：64 GiB sparse-file边界测试因本机磁盘 `ENOSPC`；
  其余位于未修改的model move Windows权限模拟、macOS executable-bit模拟和Supervisor定时
  测试。它们不在本次修改文件或调用链，未用本修复扩大范围处理。
- 未启动 Electron 做真实长任务路由切换；该产品路径保留给用户复验与后续 `QA-002`。

## 验收路径

1. 批量选择至少两个媒体并开始转写。
2. 在任务仍为准备媒体/转写时返回工具列表，再打开本工具。
3. 确认环境卡不因路由重新进入 loading，任务持续运行且不新增
   `failed / limit_exceeded`。
4. 在批量草稿中先选一个文件，再次选择多个文件，确认旧文件保留且新文件追加。
5. 任务运行中执行手动刷新，确认只刷新会话/资源摘要且任务不受影响。
