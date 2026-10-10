# web 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。

### T-WEB-01 主进程联网服务、来源适配器与安全守卫

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-WEB-01, R-WEB-02 |
| 验收 | AC-WEB-01-1, AC-WEB-01-2, AC-WEB-01-3, AC-WEB-01-4, AC-WEB-01-5, AC-WEB-02-1, AC-WEB-02-2, AC-WEB-02-3 |
| 依赖 | - |
| 写集 | electron/main/web-lookup/, electron/main/index.ts, electron/preload/index.ts, electron/preload/web-lookup-api.ts, src/web-lookup/contract.ts, src/vite-env.d.ts, test/web-lookup/, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i4/T-WEB-01.md |
| 集成版本 | 45a88e0 + 未提交工作树（I4） |

#### 实现要点

按 [设计·主进程服务](design.md)。网络与 DNS 注入，测试不访问外网；实网冒烟单独运行并记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WEB-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/web-lookup | - |
| V-WEB-01-2 | integration | required | FUSIONKIT_WEB_LIVE=1 node node_modules/vitest/vitest.mjs run test/web-lookup/live.test.ts（实网只读，各来源检索与读取一次，记录输出） | - |

### T-WEB-02 联网查询设置

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-WEB-03, R-WEB-02 |
| 验收 | AC-WEB-03-1, AC-WEB-03-2, AC-WEB-03-3, AC-WEB-02-4 |
| 依赖 | T-WEB-01 |
| 写集 | src/store/useWebLookupStore.ts, src/pages/Setting/components/AgentConfig.tsx, src/pages/Setting/index.tsx, src/pages/Setting/settingNavigation.ts, src/pages/Setting/settingNavigation.test.ts, src/locales/zh/setting.json, src/locales/en/setting.json, src/locales/ja/setting.json, src/locales/zh-Hant/setting.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-WEB-01：同一工作树 45a88e0+I4，主进程服务完成后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i4/T-WEB-02.md |
| 集成版本 | 45a88e0 + 未提交工作树（I4） |

#### 实现要点

按 [设计·设置](design.md)；沿用常规设置卡片样式。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WEB-02-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/web-tools.test.ts src/pages/Setting/settingNavigation.test.ts（设置存储的默认值、代号解析与持久化清洗在 web-tools.test.ts 的 web lookup settings 组） | - |
| V-WEB-02-2 | browser | required | FUSIONKIT_AGENT_WEB_E2E=1 node node_modules/vitest/vitest.mjs run test/agent-web.electron.test.ts：设置页「Agent」分组默认关闭、开启后重载仍开启、关闭来源、代号校验；1280×860 浅色与 786×660 深色英文截图审阅 | - |
