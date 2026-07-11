# FIX-002：音频 IPC 信任边界与任务 ownership

- 日期：2026-07-11
- 状态：已完成；全量 Vitest、Vite test build 与 Electron 32 组合矩阵通过
- 对应：`AUD-P0-001`、`AUD-P1-009`～`AUD-P1-011`

## 修复

- preload 新增窄 `audioApi`，通用 `ipcRenderer` 拒绝音频 invoke/send；main 校验顶层可信 sender 与 preload capability。
- renderer 文件选择由 `webUtils.getPathForFile()` 换取 sender-bound、TTL `fileToken`；任务不再提交 `filePath`，main 复核真实文件头、大小与 dialect。
- runtime config 同步返回 sender-bound 随机 revision；相同快照缓存，任务显式携带本次 revision，避免 sync/invoke 竞态与每次重复传 Key。
- controller 以 sender/requestId 归属；取消后保留占位至原 Promise finally，renderer 销毁时批量 abort。
- recorded chunk 使用原子临时文件并在 finally/启动 TTL 清扫。
- main 生成的 output 由 sender-bound `outputToken` 控制 reveal/read，renderer 不再提交任意输出路径。

## 验证

- `tsc --noEmit` 通过；i18n 完整性通过。
- 相关 renderer/main/service 测试与全量 73 files / 560 tests、Vite test build 已通过，见实施记录。
