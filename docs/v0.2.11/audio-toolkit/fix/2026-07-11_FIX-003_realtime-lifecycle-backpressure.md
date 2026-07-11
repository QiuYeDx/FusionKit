# FIX-003：Realtime、录音生命周期与背压

- 日期：2026-07-11
- 状态：已完成；全量 Vitest、Vite test build 与 Electron 32 组合矩阵通过
- 对应：`AUD-P0-004`～`AUD-P0-006`、`AUD-P1-006`～`AUD-P1-008`

## 修复

- Voice/Captions 统一 generation、AbortController、幂等 `failSession/releaseOwnedResources`，离页和迟到成功立即回收。
- WebRTC 监听 DataChannel close/error、PC/ICE failed/closed；失败先释放 track、channel、PC 再落 UI 状态。
- `WavChunkRecorder` 对 start 中途失败、onChunk rejection、final flush 失败执行 finally 清理，并支持暂停与输入电平。
- chunked captions 使用有 item/byte/age 上限的队列，分离 queued/in-flight，停止时 abort/seal，写 store 前校验 session generation。

## 验证

- recorder、bounded queue 与 renderer service 定向测试共 17+ 项通过；`tsc --noEmit` 通过。
