# 集成验证证据

代码基线：`aab39c9a7fdc3253711b5ee07149f37391af6ca3` 加本轮工作树；精确内容见 [source-snapshot.json](source-snapshot.json)。源码集合摘要：`b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725`。共 63 个源码、测试、QA 与依赖清单文件；未增加依赖。

## 自动化回归

2026-09-30 完成最终确认边界修复后的回归：81 个测试文件，776 个用例，763 通过，13 跳过，0 失败。完整执行命令、各文件数量和跳过名称见 [unit-summary.json](unit-summary.json)；原始 JSON 留在 `test-results/home-agent/unit-results.json`。这是 Agent、相关 store、字幕服务及工作台批处理/转写控制/翻译会话的选定回归范围，不称为全仓库全量 CI。

关键覆盖：重复发送与工具调用、会话变化和取消、迟到结果、缺失工具回执、上下文预算、两种协议终止、工作台准备/提交/失败/过期、固定选择器权限、资料投影、12 步计划上限与依赖、精确任务队列、会话导入、重命名否定及非命令文本、历史 Markdown 与真实动作确认隔离。

类型检查 `node node_modules/typescript/bin/tsc --noEmit --pretty false` 退出 0。2026-10-03 最终 `git diff --check` 退出 0；存在 Git 的 LF→CRLF 提示，没有空白错误。

## 构建与本地化

`node node_modules/vite/bin/vite.js build --mode=test` 成功，renderer 6077 / main 357 / preload 408 个模块；生成 `index-CBWrlmRW.js`。有大 chunk 和 useModelStore 同时静态/动态导入提示，没有构建错误。`node scripts/check-preload-bundle.mjs` 通过，仅保留 Electron 外部模块。

`node scripts/check-i18n.mjs` 与 `node scripts/check-i18n-usage.mjs` 通过。Home 命名空间四语言各 189 键；扫描 3008 个调用、解析 3192 个键。23 项相同译文提示均位于未修改的命名空间，不属于缺键。

## Electron 渲染与交互

最终源码构建后于 2026-10-03 执行 `node scripts/home-agent-qa.mjs`：`success=true`，15 张截图，7 组检查，7 次本地合成模型请求，0 pageErrors。明细见 [ui-report.json](ui-report.json)。仅使用独立 user-data-dir 与自建字幕 fixture，真实走 Electron/preload/字幕导入及任务服务；模型回答和译文由回环 HTTP 服务合成。

- 中文浅色、繁中深色 1280×860；英文深色、日文浅色 786×660。计划、结果及目录测得横向 overflow=0。
- 无模型时禁止发送；计划折叠/展开、能力目录/键盘关闭、失败和未完成回执均覆盖。
- 实际导入字幕 → 准备翻译 → 取消（零任务）→ 再准备 → 确认（只加入一个指定任务）→ 合成译文完成。入队回执与后台完成明确区分。
- 历史状态 fixture 直接写入隔离 localStorage，不把这部分记作“文件导入 UI 测试”；会话 JSON 兼容与执行权清理由单元测试覆盖。
- QA finally 关闭本次 Electron 和回环服务；最终 Get-Process electron 未发现残留实例。

## 视觉审查与修复

首轮查看发现准备动作摘要固定英文、历史工具标题显示技术函数名、输入工具栏在空态转对话的布局动画期间悬在结果卡片上。分别改为有限四语言摘要/工具名映射，技术名留在展开详情，工具栏采用相邻静态流布局。

第二轮截图仍可能捕获输入模式选择器的过渡中间帧。QA 现在同时等待工具栏距输入 0–40px、模式与发送按钮相对输入居中，并连续四次测量稳定，再保存截图。

最终人工查看了待确认、提交回执、英文窄窗计划/错误及日文能力目录；长文本自然换行，确认操作与输入区分离，底部导航无覆盖，输入模式/按钮已归位。归档代表图：

- [待确认翻译](screenshots/prepared-translation-light.png)
- [提交回执](screenshots/submitted-translation-light.png)
- [英文窄窗计划](screenshots/plan-en-786.png)
- [日文能力目录](screenshots/capabilities-ja-786.png)

## 证据边界

未运行真实计费供应商请求、长音视频本地推理、macOS/Linux、安装包签名/发布。经典本地转写只完成环境/任务查询、有限配置及工具页交接，仍须用户在其页面选择真实文件。13 个跳过用例未计为通过。界面审查和测试不代替用户人工验收。
