# FIX-007：四页 UX、a11y、i18n 与页面 QA

- 日期：2026-07-11
- 状态：已完成；全量 Vitest、Vite test build 与 Electron 32 组合矩阵通过
- 对应：`AUD-P2-001`～`AUD-P2-014`

## 修复

- Realtime elapsed 以 1 秒 tick 更新；store/DOM 设上限；运行中配置 fieldset 锁定。
- Captions 移除当前 transcription session 的 no-op prompt/assistant 能力，禁用 manual；补暂停/继续、输入电平、可见时间戳与近似 SRT 提示。
- 主要 label/control 绑定稳定 id，segmented controls 添加 radiogroup/radio/aria-checked，动态内容使用 live log。
- runtime error code 映射四语言；文本导出使用 Electron save dialog 并返回取消/路径状态。
- 四个 persist store 提升 schema version、深合并默认值并清除运行态；stream encoding 与 WAV artifact format 分离。
- 临时输出按 24 小时和 512MB 启动清扫。

## 验证结果

- 全量 73 files / 560 tests、TypeScript、四语言 i18n 1410 keys 与 Vite test build 通过。
- Electron 4 路由×4 语言×1280×800/786×540 共 32 个组合通过；严格等待全局 loading 两个节点消失，并检查白屏循环关键错误、页面异常、标题/正文与横向溢出。
- 真实麦克风、扬声器和供应商会话仍属于 `QA-002`，不影响本修复包完成状态。
