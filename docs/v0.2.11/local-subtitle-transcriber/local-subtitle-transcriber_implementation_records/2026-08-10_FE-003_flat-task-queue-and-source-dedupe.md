# FE-003 扁平任务队列与 source identity 去重实施记录

> 日期：2026-08-10
> 状态：已完成

## 完成内容

1. 移除转写页用户可见的 batch header、编号、batch progress 与嵌套 task section。
2. DropZone 独立位于扁平任务面板上方；选择文件后立即生成 draft task row。
3. 任务面板标题栏增加全部开始、清空完成、清空全部；清空运行中任务使用确认和 cancel-then-remove。
4. Start All 只消费 probe-ready draft，probe failed draft 保留；Store 按已提交 fileToken 精确消费 capability。
5. 多音轨从纵向 Radio 子层级改成单行 Select。
6. Input Authorization Registry 新增 owner-session scoped opaque `sourceKey`，并把它传入 authorized media、task summary、IPC schema 与 Session Registry immutable contract。
7. 页面对 draft + live task 做 sourceKey 防重复；Store 再按 token/sourceKey 防重并回收被拒绝 capability。
8. route unmount 不再 reset draft，使尚未开始的队列任务在 SPA 导航后仍保留；已提交任务生命周期保持不变。
9. 四语言移除本页可见批次语义并补充新状态、批量操作、重复跳过与清空确认文案。

## 保留的内部边界

- main enqueue/batchId、atomic lease transfer、config snapshot、queue admission 与 runtime slice 未删除。
- Renderer 仅 flatten `batch.tasks`；内部 batch 不再成为产品层级。
- 其他工具页和字幕 AI 翻译页面未修改。

## 验证记录

- `tsc --noEmit`：通过。
- 最终聚焦回归 12 files / 134 tests：通过；authorization 新 sourceKey 用例另行定向通过。authorization 既有 64 GiB oversized 稀疏文件用例因当前磁盘余量不足会单独报 ENOSPC。
- local-subtitle 扩大回归（排除上述 oversized 文件）：65 files / 1178 tests 通过；8 个既有 Windows/伪 macOS/flaky supervisor 用例失败，与本改动文件无交集。
- 四语言 locale key 数与 source usage 检查：通过。
- renderer/main/preload 三段 Vite test build 与 preload bundle 检查：通过。
- 真实 Electron 宽窗 `1280×800`、窄窗 `786×540` 验收：扁平列表、三项工具栏操作、无 batch DOM、无横向溢出均通过；同一路径文件再次选择后仍保持 2 条任务并出现重复跳过提示。
- `git diff --check` 与最终 diff review：通过。
