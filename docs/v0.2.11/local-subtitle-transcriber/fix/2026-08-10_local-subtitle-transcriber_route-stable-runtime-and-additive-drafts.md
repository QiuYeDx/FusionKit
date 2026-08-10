# 本地字幕转写修复：路由无关任务、增量文件草稿与应用级环境初始化

## 背景与现象

本地字幕转写在产品使用中出现三个相互关联的 Renderer 生命周期问题：

1. 批量任务运行时离开工具详情页，再返回后，处于媒体准备窗口的任务可能失败并显示
   `limit_exceeded`。
2. 文件选择器第二次选入文件时，Store 用新授权列表整体替换旧草稿，前一次选择消失。
3. 工具详情页每次挂载都会重新显示环境 loading，并重新执行 runtime/resource/backend
   检查；路由导航因此能触发本应属于应用会话的原生操作。

## 根因

页面 mount effect 同时拥有环境快照和自动 preflight：每次进入路由都会调用
`probeRuntime()`，环境 ready 后又调用 `previewBackend()`。两条只读链路最终都会进入
`LocalSubtitleMediaNormalizer.verifyRuntime()`，与任务的 `normalizeTask()` 共用
`maxConcurrentOperationsPerOwner = 1` 的原生媒体门禁。

因此 React generation guard 只能阻止旧响应写回 UI，不能撤销已经进入 main 的探测。
当路由重新挂载的探测与批量队列下一项媒体准备重叠时，任务会被当作同 owner 的第二个
媒体操作拒绝。既有 StrictMode single-flight 只合并同一时刻的相同 runtime probe，也不能
覆盖“稍后因路由返回而重新发起”的探测或 backend preview。

文件问题则来自 `handleFiles()` 在每次授权成功后调用 `setDraftInputFiles(result.data)`；Store
的该 action 明确是替换语义，并会回收不在新列表中的旧 draft capability，所以 UI 和授权
都只保留最后一次选择。

## 修复方案

### 1. 应用级环境与 backend preview 服务

- 新增 SPA 级 `LocalSubtitleEnvironmentService`，通过 `useSyncExternalStore` 向页面发布环境
  快照。
- `src/main.tsx` 在 renderer app 初始化时启动共享 session runtime，并调用一次幂等
  `ensureInitialized()`；详情页 mount 不再调用环境 IPC。
- 同时到达的初始化请求共享同一个 Promise，初始化完成后重复调用直接返回缓存；只有用户
  手动刷新才执行新的 runtime/resource 探测。
- 成功 backend preview 以 `runtimeGeneration + modelId + devicePreference` 缓存并跨路由
  复用；资源变化或安全的显式刷新会使其失效。
- 只要存在非终态 committed task，页面不发起新的 backend preview。此时手动刷新只同步
  session snapshot 和 managed resource metadata，不进入原生媒体 runtime preflight。

### 2. 增量文件选择

- Store 新增 `addDraftInputFiles()`，以当前草稿在前、新授权在后的顺序合并并按 opaque
  `fileToken` 去重。
- 合并后继续执行 100 文件上限；超出的新授权进入既有 capability cleanup retry，避免
  renderer 丢失 token 后在 main 留下无人持有的 draft。
- 文件选择器只授权当前剩余容量内的输入，并调用增量 action；清空、逐项删除和 enqueue
  成功后的 capability 语义保持不变。

## 不变边界

- 不提高 `maxConcurrentOperationsPerOwner`，不削弱 native media 并发门禁。
- 不新增或修改 IPC channel、schema、持久化字段、task lease 或 owner session 合同。
- 页面离开仍可清理未提交 draft；已 commit 的 task lease 和 main Job Manager 不由路由
  mount/unmount 控制。
- 环境 readiness 不是永久缓存：空闲时仍保留显式手动重检，资源变化会刷新资源快照并使
  backend preview 失效。

## 回归覆盖

- 环境 service：并发/重复 `ensureInitialized()` 只调用一次 runtime/resource IPC；显式
  `refresh()` 会执行一次新检查。
- backend preview：同 key 的并发请求合并，成功结果可被后续路由消费者直接复用；主动
  失效后才重新请求。
- 页面 wiring：详情页源码不再直接调用 `probeRuntime()`、`previewBackend()` 或
  `listManagedResources()`；应用入口负责启动 runtime 与环境初始化。
- 页面模型：存在 active task 时，即使 preview cache 缺失也不发起 preview。
- Store：第二次、第三次选择追加到既有草稿且保持原顺序；既有上限与 capability cleanup
  回归继续覆盖。

## 验收建议

1. 启动包含多个媒体文件的批次，在第一项转写或下一项准备媒体时返回工具列表。
2. 停留片刻后重新进入详情页，确认不出现新的环境 loading 闪烁，任务继续更新，且没有因
   导航变为 `failed / limit_exceeded`。
3. 空草稿先选择一个文件，再次打开选择器加入多个文件，确认列表保留全部选择并按选择
   先后排列。
4. 任务运行中点击环境刷新，确认任务不受影响；任务空闲后点击刷新，确认 runtime/backend
   可执行一次新检查。
