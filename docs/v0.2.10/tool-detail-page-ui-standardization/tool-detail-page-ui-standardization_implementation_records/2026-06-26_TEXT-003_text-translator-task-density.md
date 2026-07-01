# TEXT-003 长文本任务行、状态、统计和操作收敛实施记录

> 日期：2026-06-26
> 工作包：`TEXT-003`
> 范围：长文本翻译详情页右侧任务主体密度收敛、统计条抽象、任务行视觉统一。
> 基准：继续以字幕 AI 翻译详情页的紧凑任务行、面板卡头和统计条密度为准。

## 1. 本次目标

`TEXT-002` 已经把长文本翻译页右侧入口迁入 `ToolFileDropZone`、`ToolSummaryLine` 和 `ToolPanel`，但任务主体仍保留旧密度：

- 文件顺序列表是旧 `bg-muted/30` 小块；
- 批量任务列表缺少字幕任务行的状态点、10px badge、11px 次级信息；
- 状态、阶段、文件数、分片数仍是独立 `ToolStatGrid` 小卡；
- 进度、Token、成本和文件详情分散在多个旧块中。

本次工作目标是把这些主体区域收敛为“紧凑任务行 + 横向统计条”。

## 2. 关键实现

### 2.1 新增 `ToolStatBar`

新增共享组件：

- `src/pages/Tools/_shared/ui/ToolStatBar.tsx`
- `src/pages/Tools/_shared/ui/index.ts`

组件定位：

- 只接收 `items` / `title` / `icon` / `columns` / class slot；
- 不读取业务 store；
- 不理解任何业务状态枚举；
- 用一条低高度 card 承载 status / phase / token / cost / encoding 等指标，避免页面回退到多个独立指标卡。

### 2.2 长文本任务面板迁移

修改：

- `src/pages/Tools/Text/TextTranslator/components/TaskPanel.tsx`

主要变化：

- 新增业务内 `CompactTaskRow`：
  - 2.5px 状态点；
  - 13px mono 主标题；
  - 10px 状态 badge；
  - 11px 次级信息；
  - 行内图标操作；
  - 低高度进度条。
- 文件顺序列表改成同一密度：
  - mono 文件名；
  - 11px 大小/格式信息；
  - 7×7 行内上移/下移按钮。
- 批量独立任务队列改用 `CompactTaskRow`：
  - active task 使用 `bg-primary/5`；
  - waiting/running/preparing/completed/failed/cancelled 等状态通过状态点颜色反馈。
- 第一条 `ToolStatBar`：
  - 状态；
  - 阶段；
  - 文件；
  - 分片。
- 第二条 `ToolStatBar`：
  - 输入 Token；
  - 预估成本；
  - 文件大小；
  - 编码；
  - 置信度。
- 保留并前置关键 Alert：
  - 任务错误；
  - 模型缺失；
  - Markdown 限制提示。

## 3. 未改范围

- 未修改 text translation store、IPC、主进程 service 或任务协议。
- 未改恢复弹窗 `RecoveryDialog`。
- 未新增 i18n key；复用现有 `text` namespace 文案。
- 未清理 `ToolStat` / `ToolStatGrid` / `ToolActionBar` 导出，统一留给 `CLEAN-001` 做全局删除判断。

## 4. 验证

### 4.1 静态与测试

执行命令：

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run test/text-translation src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
```

结果：

- `tsc --noEmit`：通过；
- text 相关测试：初次在沙箱内因本地 fake server `listen EPERM 127.0.0.1` 失败；按权限规则放开后重跑通过，`19 files / 150 tests passed`；
- i18n：`8 namespaces / 930 keys`，四语言数量一致；
- Vite build：renderer、main、preload 均构建成功；仅有既有 chunk 体积和动态导入 warning；
- `git diff --check`：通过。

### 4.2 Electron 视觉矩阵

临时脚本：

```text
/private/tmp/fusionkit-text-task-visual-matrix.mjs
```

脚本策略：

- 使用 Playwright Electron 启动真实 Electron 窗口；
- 通过 `VITE_DEV_SERVER_URL=http://127.0.0.1:7777/` 连接本次 Vite dev server；
- 每次截图前显式等待：
  - `.app-loading-wrap` 不存在；
  - `#app-loading-style` 不存在；
  - 路由为 `#/tools/text/translator`；
  - `#text-translator-config-panel` 可见；
  - `#text-translator-upload-zone` 可见；
  - `#text-translator-task-panel` 可见；
  - 主题 class 与预期一致；
  - 无 modal dialog。
- 写入稳定的视觉 QA 模型配置，避免模型缺失 Alert 干扰主体任务区。
- 使用真实临时 TXT 文件触发文件选择，再点击“准备任务”进入 waiting / prepared 状态。

覆盖矩阵：

| 尺寸 | 主题 | 状态 | 结果 | 截图 |
| --- | --- | --- | --- | --- |
| 786×540 | Dark | 空状态 | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-dark-empty.png` |
| 786×540 | Dark | 已选 2 个 TXT | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-dark-selected.png` |
| 786×540 | Dark | 已准备 waiting | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-dark-prepared.png` |
| 786×540 | Light | 空状态 | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-light-empty.png` |
| 786×540 | Light | 已选 2 个 TXT | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-light-selected.png` |
| 786×540 | Light | 已准备 waiting | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-min-light-prepared.png` |
| 1440×900 | Dark | 空状态 | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-dark-empty.png` |
| 1440×900 | Dark | 已选 2 个 TXT | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-dark-selected.png` |
| 1440×900 | Dark | 已准备 waiting | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-dark-prepared.png` |
| 1440×900 | Light | 空状态 | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-light-empty.png` |
| 1440×900 | Light | 已选 2 个 TXT | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-light-selected.png` |
| 1440×900 | Light | 已准备 waiting | loading=no；pageOverflow=no；globalOverflow=no | `/private/tmp/fusionkit-text-task-visual-matrix/text-translator-wide-light-prepared.png` |

补充说明：

- 本次矩阵已修复“全局 Loading 尚未退出就截图”的问题，脚本直接检查 loading DOM 是否移除。
- prepared 状态截图中有成功 toast 出现在右上角，这是截图噪声；DOM 指标仍确认页面已初始化完成，且任务行、统计条、文件顺序列表和批量 waiting 行均正常渲染。
- 视觉重点已抽看：
  - `text-translator-wide-light-prepared.png`：右侧任务行与两条统计条完整可见；
  - `text-translator-min-light-prepared.png`：最小窗口下通过滚动可访问任务队列和统计条，无整页横向溢出。

## 5. 前端进程清理

本次启动过：

```text
./node_modules/.bin/vite --host 127.0.0.1 --port 7777
```

Electron 由 Playwright 脚本启动，并在脚本 `finally` 中 `app.close()`。

按 AGENTS 要求，回答用户前已对本次启动的前端服务执行清理：

- Vite dev server 已通过当前终端 session 发送 `Ctrl-C` 关闭，退出码 `130`；
- Playwright Electron 已由脚本 `finally` 中的 `app.close()` 关闭；
- 最终 `ps` 进程检查曾尝试执行，但当前环境的自动审批/额度限制拒绝了该检查命令；未再绕路重试。

被拒绝的检查命令为：

```text
ps -axo pid,ppid,command | rg 'FusionKit/(node_modules/.bin/vite|node_modules/.bin/../vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|127.0.0.1:7777|--port 7777|vite --host 127.0.0.1' | rg -v 'rg '
```

## 6. 后续建议

下一步认领 `TEXT-004`：

- 核对恢复弹窗的打开、刷新、恢复、重启、删除和打开工作区；
- 核对 active task 与 queued task 切换；
- 补充 `zh` / `en` / `ja` 的按钮长度和响应式视觉回归；
- 如需要，把 prepared 截图脚本再加上 toast 消失等待，获取更干净的人工验收图。

遗留风险：

- `CompactTaskRow` 暂留在长文本业务组件内，符合当前“任务行不抽象业务状态”的原则；若未来两个以上工具出现同构任务行，再考虑提升为共享壳。
- `ToolStat` / `ToolStatGrid` / `ToolActionBar` 仍保留导出，等待 `CLEAN-001` 统一检查引用后删除。
