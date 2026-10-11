# 实施记录：T-SPLIT-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-SPLIT-02 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:5712e310e4c453d2d4734819d13281f105e516436bbac84cb42bc37f12116c23 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | edaf5b25b0b5ee0f02330e90b9495da08c7d548ccf73beb344e44d3eeb401962 |

## 实际结果

右键菜单新增“拆分字幕…”（只选一条时可用）与“在上方 / 下方插入字幕…”；拆分对话框以文本框光标放置拆分位置（鼠标或方向键，文字不可修改），默认在中间附近的标点或空格后，主进程建议拆分时刻并注明依据，可改；两半预览可试听；有译文时可一并拆分或留在第一条。插入对话框默认填入空隙，检查顺序 / 结束 / 媒体时长，可试听。应用后选中新字幕；撤销标签“拆分字幕”“插入字幕”。渲染审查发现的三处问题已修复复验。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SPLIT-02-1 | 通过 | file:records/regression-electron.log |
| V-SPLIT-02-2 | 通过 | file:records/render-review.md |
| V-SPLIT-02-3 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SPLIT-03-1 | 通过 | V-SPLIT-02-1 |
| AC-SPLIT-03-2 | 通过 | V-SPLIT-02-1 |
| AC-SPLIT-03-3 | 通过 | V-SPLIT-02-2 |

## 风险与未执行项

界面测试以键盘（End + 方向键）放置拆分位置，鼠标点击放置由同一 select / click 读取路径处理，未单独以坐标点击测试。翻译进行中入口禁用沿用菜单的 editBlocked 机制，未在本测试中单独覆盖。
