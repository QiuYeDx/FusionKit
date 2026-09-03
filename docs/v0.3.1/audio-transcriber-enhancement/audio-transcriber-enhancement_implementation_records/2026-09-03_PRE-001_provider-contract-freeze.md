# 工作包 PRE-001：供应商合同冻结

## 基本信息

- 日期：2026-09-03
- 状态：废弃（整批需求于 2026-09-03 搁置归档）
- 模块：PROVIDER
- 关联需求：BR-01、BR-03、BR-04、BR-06、BR-11、BR-15
- 对应设计：`audio-transcriber-enhancement_final_design.md` 第 1.7、3、19 节
- 对应计划：`audio-transcriber-enhancement_execution_plan.md` / `PRE-001`
- 前置依赖：无

## 本次认领边界

- 目标：核对 OpenAI/MiMo 官方合同，建立 MiMo 异常 fixture，决定 Silero 是否进入首版。
- 修改文件范围：fake provider fixture/tests、PRE 证据、Final Design、Execution Plan、本记录。
- 明确不涉及：页面、production adapter、媒体 pipeline、真实媒体/密钥、依赖下载。

## 本次实现内容

- 冻结 route 候选值与 fail-closed 边界；新增 MiMo finish reason、usage、空/缺 choice、SSE 断流和十进制 Base64 边界 fixture。
- 审计仓库依赖及本地字幕 VAD 调用面，确认不存在可直接复用的 official standalone Electron executor，`VAD-001` 后移。
- 真实供应商矩阵因本机无 OpenAI/MiMo 密钥而未执行；fake 证据没有替代真实证据。

## 修改文件

| 文件 | 变化 |
| --- | --- |
| `test/audio/fakeAudioApiServer.ts`、`.test.ts` | 扩展 MiMo ASR 合同夹具并补 4 类测试 |
| `poc/2026-09-03_PRE-001_provider-contract-evidence.md` | 记录官方依据、冻结值、阻塞和 Silero 决策 |
| Final Design / Execution Plan / 本记录 | 同步设计版本、Q-01、状态、证据与交接 |

## 接口、兼容与安全检查

- 生产接口无变化；fixture 新增 `createMimoStreamingAsrEvents` 与 usage/finish reason options，测试新增 Base64 字符边界公式。
- OpenAI 与 MiMo 继续使用独立 response/upload 合同；未知或未登记模型 fail closed。
- 未记录 API key、真实路径、raw body 或媒体；没有启动生产子进程和临时产物。

## 验证结果

| 命令或场景 | 结果 | 证据/未覆盖原因 |
| --- | --- | --- |
| `.\node_modules\.bin\vitest.cmd run test/audio/fakeAudioApiServer.test.ts` | 通过 | 1 file / 10 tests |
| `.\node_modules\.bin\tsc.cmd --noEmit` | 通过 | 沙箱外跟随 pnpm junction 后无诊断 |
| 真实 OpenAI/MiMo 最小矩阵 | 未运行 | `OPENAI_API_KEY`、`MIMO_API_KEY` 均未配置 |
| Silero runtime 静态审计 | 通过 | 无 standalone surface；本地字幕 VAD 仅在 whisper-server 内部 |

## 未完成事项与风险

- 本记录创建时因缺少密钥阻塞；随后用户决定搁置整批需求，因此不再等待凭据，也不解锁 `CORE-001`。未来恢复时由新计划重新分配 owner 并复核全部外部合同。
- `VAD-001` 已有终止依据；后续若引入 pinned official executor，应作为新需求审查 runtime、许可、取消和 packaged/no-PATH。

## Definition of Done

- [x] 官方合同、fixture、Silero 决策和隐私边界已有可复核证据
- [x] focused fake-provider tests 通过，台账/record 同步
- [ ] 真实供应商正常与异常矩阵通过
- [ ] 候选 MP3 profile、4/5 分钟策略与 provider 边界最终冻结

## 下一步建议

- 下一可领取工作包：无；本记录随归档分支只读保留。
- 若未来重新立项：密钥只由本机环境读取，样本与 raw response 不进入 Git。
