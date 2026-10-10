# 实施记录：T-WEB-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-WEB-01 |
| 日期 | 2026-10-10 |
| 验证版本 | 45a88e0 + 本会话未提交改动（I4 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2）；本机代理为 fake-IP 模式 |
| 任务指纹 | 11ab5294b38ffaa4d0456865d21d47e413687a656e82f0ffc491b0d291692b6e |

## 实际结果

- 主进程 `electron/main/web-lookup/`：`guard.ts`（http/https、无凭据、默认端口；回环/私有/链路本地/CGNAT/组播/保留与 IPv6 对应段拒绝，含 `::ffff:7f00:1` 写法；198.18.0.0/15 按设计放行）、`html.ts`（去脚本/导航/编辑链接，优先 main/article，回退页面描述）、`sources.ts`（维基百科 zh/zh-Hant/ja/en、萌娘百科镜像、百度百科词条卡片、B 站游戏 Wiki、必应含 `site:` 与跳转链接解码）、`service.ts`（手动跟随重定向最多 3 次并逐跳校验、2 MiB、类型白名单、15 s、无 Cookie，直连时连接也只用公网解析结果）、`index.ts`（只接受本应用窗口主框架的请求）。
- preload 新增固定桥 `window.webLookup`（search/read），旧通用桥拒绝 `web-lookup:` 命名空间；`electron/main/index.ts` 注册；两个组合文件按项目流程记录审阅（`current-composition-audits.json`、`current-integration-audits.v1.json`）。
- 实网实测发现并修正：fake-IP 网段被误拒（全部境外来源不可用）、中文维基简繁混排、官网为脚本页面无正文。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WEB-01-1 | 通过 | file:records/i4/web-01-unit.log |
| V-WEB-01-2 | 通过 | file:records/i4/web-01-live.log |

- V-WEB-01-1：18 通过；实网文件默认跳过
- V-WEB-01-2：5 个来源各检索与读取；官网读到 524 字描述

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WEB-01-1 | 通过 | V-WEB-01-1, V-WEB-01-2 |
| AC-WEB-01-2 | 通过 | V-WEB-01-1, V-WEB-01-2 |
| AC-WEB-01-3 | 通过 | V-WEB-01-1, V-WEB-01-2 |
| AC-WEB-01-4 | 通过 | V-WEB-01-1, V-WEB-01-2 |
| AC-WEB-01-5 | 通过 | V-WEB-01-1 |
| AC-WEB-02-1 | 通过 | V-WEB-01-1 |
| AC-WEB-02-2 | 通过 | V-WEB-01-1 |
| AC-WEB-02-3 | 通过 | V-WEB-01-1 |

## 风险与未执行项

- 第三方站点结构随时可能变化（镜像、必应页面、百科卡片接口）；以稳定错误码降级，需定期运行实网冒烟。
- 经代理访问时，目标解析由代理完成，只做请求前检查。
- IPv6 fake-IP（如 fdfe:dcba:9876::/48）仍按 ULA 拒绝；默认配置不返回 IPv6，如遇到再评估。
