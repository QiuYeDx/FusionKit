# 实施记录：T-RUNTIME-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-RUNTIME-04 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动 |
| 环境 | Windows 11，Node（vitest 2.1.9） |
| 任务指纹 | 14c356e0164f67b8c82d2fbaa7c2eb7277b022b68fe91cce3dc580b72570274a |

## 实际结果

- 新增 `src/agent/navigation-tools.ts`：固定工具 `open_app_page`，页面键为枚举（首页、工具列表、字幕工作台、翻译知识库、字幕翻译、转换、提取、本地转写、名称翻译、模型设置），不接受任意路径。应用导航器由常驻的 `AgentDock` 通过 `setAgentNavigator` 提供，未挂载时返回 `navigation_unavailable`。
- 跳转后最多等待 2000ms，直到目标页注册页面上下文，返回路由、页面名、主题与快照；目标页没有上下文时只返回路由与页面名；已在目标页时返回 `alreadyOpen` 且不重复导航。
- 系统提示新增“Opening pages”规则：用户要求查看、或刚在某工具页添加任务时适合切换。切换后本轮仍只能用本轮开始时的页面工具，新页面的页面工具从下一条消息起可用。
- 工具调用与结果视图有页面名称与“已打开「…」”摘要，四种语言的文案与动态键清单已补齐。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RUNTIME-04-1 | 通过 | inline:`vitest run src/agent/navigation-tools.test.ts` 3 项通过（枚举与无导航器、跳转等待注册并返回快照、超时与已在目标页）；`vitest run src/agent src/services/name-translation` 25 文件 280 项通过 |
| V-RUNTIME-04-2 | 通过 | inline:`tsc --noEmit` 0 错误；`check-i18n.mjs`、`check-i18n-usage.mjs` 通过（All source translation keys resolve） |

浏览器内的真实跳转（首页 → 字幕翻译页）见 T-WORKSPACE-08。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RUNTIME-04-1 | 通过 | V-RUNTIME-04-1 |
| AC-RUNTIME-04-2 | 通过 | V-RUNTIME-04-1 |
| AC-RUNTIME-04-3 | 通过 | V-RUNTIME-04-1, V-RUNTIME-04-2 |
| AC-RUNTIME-04-4 | 通过 | V-RUNTIME-04-1 |

## 风险与未执行项

真实模型何时主动调用 `open_app_page` 取决于供应商对提示的遵循，本批只用受控合成响应验证。
