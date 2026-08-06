# 模型下载取消修复：主动中断阻塞中的响应流

## 背景与现象

手工运行应用下载内置模型时，点击取消按钮后界面持续显示处理中，模型文件仍继续下载。
既有自动化测试会在两个可立即读取的数据块之间触发取消，因此没有覆盖真实网络响应正等待
下一块数据的情况。

## 根因

主进程下载器使用 `for await` 消费 HTTPS response body，并只在取得新数据块后检查
`AbortSignal`。当迭代器阻塞在下一块网络数据时，代码无法再次执行取消检查。HTTPS request
在响应头返回后已经完成打开阶段，原实现也没有把后续 abort 主动绑定到当前 response 的
`destroy()`，所以任务长期停留在 `cancelling`，清理逻辑也无法开始。

第一轮修复只在 abort 时调用 response `discard()`。后续真实 UI 复验发现下载字节仍持续
增加，证明该方案还错误依赖了“discard 必然让 pending async iterator 结束”。取消是否停止
写入不能由底层流的合作行为决定。

第二轮同时销毁 request/response 并让 chunk wait 与 abort 竞争后，真实 UI 仍表现为取消按钮
持续 loading、已下载字节继续增加。继续检查完整链路发现下载器会为每个 HTTPS 小 chunk
同步发布一次 ResourceJob revision 和 Electron IPC event；1.01 GB 模型可产生数万条消息。
renderer 点击取消后，invoke 与 `cancelling` 事件会被旧进度消息积压拖延，因此界面继续消费
排队中的递增字节，底层 transport 也不能及时收到 cancel。另一个独立问题是瞬时连接失败、
临时 HTTP 响应或 premature close 会直接把首次 ResourceJob 结算为 failed，用户第二次点击
实际上承担了本应由同一下载任务执行的安全重试。

## 修复后行为

1. 下载器取得可消费的响应后，为当前 response 注册一次性 abort listener。
2. 取消同步触发幂等 `discard()`，同时销毁 HTTPS `ClientRequest` 与 response。
3. 下载循环不再直接使用 `for await`；每次 `iterator.next()` 都独立与 `AbortSignal` 竞争。
   即使 discard 后 iterator 永远 pending，循环也会按原始 abort reason 退出，不再写入新块。
4. 下载器关闭文件句柄并删除 `.part` 与 metadata；Model Manager
   清理 staging 后将 ResourceJob 收敛为 `cancelled`。
5. 响应正常结束或失败后在 `finally` 移除 listener，避免监听泄漏或后续重复销毁。
6. 不改变 renderer IPC、ResourceJob 状态机、下载续传或原子提交合同。
7. 下载进度在进入 SessionRegistry/Electron IPC 前按 100 ms 上限合并，只强制发布首值和
   exact 末值；await 文件写入后会再次检查 abort，取消后不再发布进度。
8. 同一下载任务对明确的瞬时网络错误、HTTP 408/425/429/500/502/503/504 和短响应执行
   最多两次可取消退避；有可信 validator 时沿用 Range/If-Range，否则清理空/不可信 part
   后从零重启。策略、完整性、磁盘和文件系统错误仍立即失败。

## 影响文件

- `electron/main/local-subtitle/resource-download.ts`
- `test/local-subtitle/resourceDownload.test.ts`
- `test/local-subtitle/modelManager.test.ts`
- `test/local-subtitle/modelManagerIpc.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/interrupt-stream-transport-on-abort.md`
- `.agents/skills/fusionkit-pitfall-guard/references/throttle-streaming-progress-before-electron-ipc.md`
- `.agents/skills/fusionkit-pitfall-guard/references/retry-transient-downloads-inside-one-resource-job.md`

## 回归覆盖

- 下载器测试构造一个先返回首块数据、随后永久 pending、只在 `discard()` 时拒绝的 response
  body，证明取消同步中断 transport，而不是等待下一块数据。
- 第二个下载器测试让 `discard()` 成功返回但 iterator 永远 pending，证明取消结算与停止写入
  不再依赖 transport 唤醒迭代器。
- Model Manager 集成测试通过真实下载器进入同一 stalled body，调用 owner-scoped cancel，
  验证任务进入 `cancelled`，response 只 discard 一次，下载临时状态和 staging 全部消失。
- Model IPC 集成测试覆盖 fixed public cancel channel，验证返回 `{ cancelled: true }` 后同一个
  不合作 response 仍能收敛为 `cancelled`。
- 首次 `ECONNRESET`、HTTP 503 和 body 中断均在同一个 download/ResourceJob 内恢复；续传
  请求携带 exact Range 与 If-Range，不要求第二次点击。
- 256 个同步 chunk 的下载器测试只发布首尾两次进度；1024 个 chunk 的 public IPC 集成
  安装最终只有一个 completed job，resource events 少于 12 条。
- 30 秒 retry delay 中取消立即按原始 abort reason 结算，不等待 timer。
- 既有续传、redirect、validator、普通块间取消与完整本地字幕测试继续通过。

## 验证结果

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode test
node scripts/check-preload-bundle.mjs
git diff --check
```

- 聚焦回归：3 files / 61 tests passed。
- 本地字幕回归：53 files passed、4 files skipped；1078 tests passed、4 tests skipped。
- TypeScript、renderer/main/preload 三段 test build 与 sandboxed preload bundle gate 通过。
- 按用户要求未启动应用，也未重复下载 1.08 GB 真实模型；最终 UI 网络下载取消由用户按
  原手工路径复验。

## 后续建议

在 `QA-002` 的真实 cancel/import 竞态矩阵中加入弱网或暂停响应场景，确认按钮 loading、
ResourceJob 终态和磁盘占用在 Electron 产品界面中一致收敛。
