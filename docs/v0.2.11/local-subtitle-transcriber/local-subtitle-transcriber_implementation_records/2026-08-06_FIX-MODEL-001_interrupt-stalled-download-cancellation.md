# 工作包 FIX-MODEL-001：中断阻塞中的模型下载取消

## 基本信息

- 日期：2026-08-06
- 状态：已完成
- 对应执行计划工作包：`MODEL-002` 手工验收修复 checkpoint

## 本次实现内容

- 复现并定位点击取消后模型仍下载的问题：response body 正等待网络块时，循环内的
  `AbortSignal` 检查无法执行。
- 为 active response 绑定 abort listener，取消时幂等销毁 request/response，并在
  `finally` 解除监听。
- 每个 `iterator.next()` 直接与 abort 竞争，即使 discard 后 body 永远 pending，也停止
  后续文件写入并进入取消清理。
- 修复真实下载的第二个阻塞点：不再为每个网络 chunk 发布 ResourceJob/Electron IPC
  progress，改为 100 ms 合并并保留 exact 首尾更新，避免旧进度消息把 cancel invoke 与
  `cancelling` 事件压在队列后面。
- 在同一个 job 内对明确的瞬时连接错误、临时 HTTP 状态与 premature close 做两次可取消
  重试；有安全 validator 时自动 Range/If-Range 续传，避免首次失败后必须手动再点一次。
- 保留原取消原因及既有 `.part`、metadata、staging 身份绑定清理语义。
- 增加 cooperative/stubborn stalled iterator 单测、Model Manager ResourceJob 与 fixed
  public IPC 集成回归。
- 新增 `FK-PIT-0076`，防止以后用“两个现成 chunk 之间取消”的测试替代 stalled stream
  中断证据。
- 新增 `FK-PIT-0077/0078`，分别约束 streaming progress IPC 频率和同一 job 内的有限
  瞬时重试。

## 修改文件

- `electron/main/local-subtitle/resource-download.ts`
- `test/local-subtitle/resourceDownload.test.ts`
- `test/local-subtitle/modelManager.test.ts`
- `test/local-subtitle/modelManagerIpc.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-08-06_local-subtitle-transcriber_interrupt-stalled-model-download.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/interrupt-stream-transport-on-abort.md`
- Execution Plan 与本实施记录

## 接口或数据结构变化

- 无公开 IPC、schema、renderer API 或持久化格式变化。
- `LocalSubtitleDownloadResponse.discard()` 现被明确用于 abort 时主动中断 active body；接口
  本身未变。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode test
node scripts/check-preload-bundle.mjs
git diff --check
```

结果：

- 聚焦回归 3 files / 61 tests passed。
- 本地字幕回归 53 files / 1078 tests passed；4个真实资源或 native 测试按默认配置 skipped。
- TypeScript、三段 Vite test build 和 preload sandbox external-module gate 通过。
- 按用户要求未启动 Vite/Electron 应用，未执行依赖公网速度的真实大模型下载。

## 未完成事项

- 用户仍需在应用 UI 中以真实网络下载复验取消后的按钮状态、任务终态与磁盘占用。
- 弱网/暂停响应的 Electron 产品矩阵继续归 `QA-002`。

## 下一步建议

- 用户在网络恢复后从模型管理 UI 开始下载并取消；确认进度立即停止、按钮退出 loading、
  任务显示已取消，重新下载可以正常从干净状态开始。
