# I4 集成结果

2026-10-10，基线 45a88e0 + 未提交工作树（I1–I4）。任务记录见本目录 `T-*.md`。

## 用户能做什么

- 设置 → Agent：打开「允许 Agent 联网查询资料」（默认关闭），按需关闭某个来源，填写 B 站游戏 Wiki 代号（如 `zzz`）。不需要任何账号或密钥。
- 对 Agent 说“查一下××的官方译名”：Agent 按来源优先级检索（一般→维基百科；二次元→萌娘百科（镜像）、百度百科；游戏内名称→B 站游戏 Wiki；官方说法→必应限定官网），读取页面后回答并注明页面。
- 让 Agent 记下查到的译法：资料卡片上每条注明「来自 站点」，默认待审核；确认后资料证据为网页（链接、标题、访问时间）。
- 未开启时，Agent 会说明在哪里开启，也可以替你打开设置页。

## 合规与基础设施

- 只发送检索词与页面链接；不接需要密钥的服务；不绕过验证码或访问限制（萌娘百科官方站点、百度百科页面、百度/DuckDuckGo 搜索因此未接）。
- 读取限制：公网 http/https、逐跳校验重定向（≤3）、2 MiB、网页/文本/JSON、15 s、无 Cookie；直连时连接只用公网解析结果。198.18.0.0/15 按 fake-IP 放行（见 module-web 设计）。
- `electron/main/index.ts`、`electron/preload/index.ts` 组合变更已按项目流程记录审阅；Studio 依赖边界 0 错误。

## 验证摘要（最终代码）

| 范围 | 结果 |
| --- | --- |
| 单元（联网服务/工具/提示/行/导航/设置） | 全部通过：file:records/i4/web-01-unit.log、web-02-unit.log、agent-07-unit.log |
| 实网冒烟（只读） | 5 个来源全部通过：file:records/i4/web-01-live.log |
| 全量 vitest | 5516 通过、89 跳过、4 失败；失败均在本批未改动的本地转写/转写任务模块（负载下超时类），单独重跑 3 个文件 144/144 通过：file:records/i4/full-regression.log、full-regression-rerun.log |
| 来源审计 / Studio 边界 | 424 通过、6 跳过 / 0 错误：file:records/i4/provenance.log、boundaries.log |
| 类型检查 / i18n | 0 错误 / 全部键可解析：file:records/i4/static-tsc.log、static-i18n.log |
| Electron（最终构建） | 联网、资料卡片、悬浮面板通过；`agent-handoff` 仍失败于既有的面板滚动条断言（I3 已在干净基线复现并另开任务）：file:records/i4/final-electron.log |

## 截图索引

| 文件 | 内容 |
| --- | --- |
| screenshots/01-refused-off-home-1280-light.png | 未开启时的失败行与 Agent 说明 |
| screenshots/02-settings-off-1280-light.png | 设置 → Agent 默认状态 |
| screenshots/03-settings-invalid-code-1280-light.png | 代号校验错误 |
| screenshots/04-settings-on-1280-light.png | 已开启、关闭萌娘百科、代号 zzz（重载后） |
| screenshots/05-web-card-ready-home-1280-light.png | 来源关闭失败行、检索与读取行、带「来自 wiki.biligame.com」的资料卡片 |
| screenshots/06-search-row-expanded-1280-light.png | 检索行详情：结果标题与站点 |
| screenshots/07-web-card-saved-home-1280-light.png | 保存后 |
| screenshots/08-settings-786-dark-en.png | 窄窗口深色英文设置页 |

## 未覆盖与待用户验收

- 真实模型的检索策略与引用质量需试用；第三方站点可用性会变化。
- ja / zh-Hant 未截图审阅。
- 用户验收未签署（spec.json acceptance 为 pending）。
