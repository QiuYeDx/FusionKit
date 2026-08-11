# 本地字幕转写：扁平任务队列与精确防重复

> 日期：2026-08-10
> 范围：仅本地字幕转写工具详情页及其 local-subtitle IPC/domain 合同
> 不在范围：其他工具页、字幕 AI 翻译工具既有组件、主进程推理调度模型

## 1. 目标

本地字幕转写不再向用户展示“转写批次”。选择文件后，文件立即以待开始任务进入与运行中、完成、失败任务相同的扁平列表。列表标题栏提供“全部开始”“清空完成”“清空全部”，每个文件始终只对应一个任务行。

## 2. 产品模型

- draft 文件是 `读取信息中 / 待开始 / 读取失败` 的任务，不再在上传卡片中重复展示。
- 已提交任务继续由 main 的 revisioned session snapshot/event 驱动；renderer 只把所有内部 batch 的 tasks 扁平化展示。
- “全部开始”只提交当前已经 probe ready 的 draft；读取失败的任务留在原位供重试或移除。
- “清空完成”只移除已经完成且自动翻译交接已收敛的任务。
- “清空全部”先清除 draft，再取消非终态任务，并在任务进入可删除终态后移除；已经导出的字幕文件不删除。
- 多音轨选择改为任务行内的紧凑 Select，不展开纵向子卡片。

## 3. 内部执行边界

产品层取消批次不等于删除 main 的内部事务。一次“全部开始”仍通过一个内部 enqueue request 原子冻结成员、配置、output lease、runtime/backend proof，并获得一个 queue-admission execution wave。`batchId` 继续用于 main/session/lease/recovery，不进入任务列表标题、编号、分组或进度 UI。

这样可继续满足 FK-PIT-0054：同一 admission 的连续 sibling task 共享正确的 runtime slice，单任务取消、失败或重试不会破坏其他任务的 exact runtime pin。

## 4. 同路径防重复

renderer 不得接收真实路径，也不能用 `displayName + byteSize` 猜测文件是否相同。Input Authorization Registry 按 owner session + 规范化 canonical path 生成随机 `sourceKey`：

- 同一 owner session 再次授权同一路径时复用相同 `sourceKey`；
- 不同 owner session 使用不同 key；
- key 不含路径/hash，不持久化，只表示同一会话内的相等关系；
- authorized draft 与 live task summary 都携带该 key；
- renderer 将新授权与尚未清除的 draft/task 比较，重复项不入队，并立即排入 capability revocation；
- 任务清除后列表中不再有该 key，因此允许重新添加同一文件。

Store 还需再次按 `fileToken` 和 `sourceKey` 去重，作为页面竞态与未来调用方的第二道防线。

## 5. 路由生命周期

draft 已经是任务队列的一部分，SPA 路由离开时不能清空。Zustand 只在内存中保留 draft capability，返回详情页后重新 probe；显式移除、清空、owner release 或过期才进入 cleanup。已提交任务继续完全由页面外 runtime service/main Job Manager 执行。

## 6. 验收

- 页面中无批次标题、编号、批次进度或 nested batch card。
- 上传区与任务区不重复显示同一文件。
- draft、运行中和终态任务共用一个 `divide-y` ToolPanel。
- 工具栏包含全部开始、清空完成、清空全部；运行中清空需确认。
- 无蓝色任务背景、无左侧深色边框报错样式。
- 多次选择追加而非替换；同路径未清除任务不可重复加入。
- route unmount 不清 draft、不取消已提交任务。
- sourceKey 不包含 raw path、不进入持久化偏好。
- TypeScript、IPC schema、authorization/session/store/page tests、i18n 与 diff check 通过。
