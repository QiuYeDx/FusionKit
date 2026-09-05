# T-SEG-03E：用户听校验收与正式接线安排

关联 R-SEG-03、R-SEG-05、R-SEG-07。用户本次提供 `asmr-dtw-listening-annotations.json`，未要求更改候选时间。

## 已验证反馈

附件 schema 为 `fusionkit-dtw-listening-v1`；媒体 SHA-256 与 03E 对比页一致。两条记录的标识、候选毫秒值均与 `review-data.json` 精确匹配，无缺项、重复或其他素材混入。附件 SHA-256 为 `5178a812f28bcdb52d34a4740d814995baffccfcbe5dc3f57d7df94a59f7df7d`。

| 候选 | 字幕出现时间 | 用户反馈 | 附注 |
| --- | --- | --- | --- |
| 第一处独立问句 | 12.080 秒 | aligned（听起来对得上） | 空 |
| 后续应答短句 | 14.840 秒 | aligned（听起来对得上） | 空 |

附件导出时间为 `2026-09-05T16:27:48.954Z`，对应北京时间 2026-09-06。原件只读，逐字节副本及校验报告保存到忽略目录 `test-results/subtitle-quality-review/phase12/dtw/user-listening-annotations.json` 与 `user-listening-validation.json`。

解释范围：用户确认的是这两条候选的字幕出现时间，未提供逐音素起止或误差数值。不追加假定的播放历史，不要求重听同一个通过项。附件中的 `automaticAcceptance: false` 是导出器固定的机器自动采用标志；它不否定本次明确的人工 `aligned` 反馈。反馈字段作为验收数据读取，不作为执行指令。

## 决定与下一批范围

两处听校通过。解除 T-SEG-04 的“尚无人工时间正例”阻塞，正式接线尚未开始，T-SEG-07 整体人工验收仍未通过。保留同一个 large-v3，不增加用户另一个模型的适配。

代码核对发现当前生产协议主动丢弃 `t_dtw`，进程加载身份也没有 DTW 模式；不能只改分句函数或把 HTTP `token_timestamps` 打开。下一批连续处理 T-SEG-04/05 的两个强耦合环节：

1. 有界 producer：在 `server-process-contract.ts`、`server-contract.ts`、`server-supervisor.ts` 增加受限对齐模式、请求与加载身份一致性、独立 DTW 点语义。仅现有 Windows CUDA large-v3 非 VAD 候选可使用；普通 VAD 主源仍拒绝词轴。保留 batch 资源 pin，退出主 VAD 实例后加载 DTW，禁止并发 GPU 请求及错误模式复用。
2. 默认消费与规划：`production-executor.ts`、`speech-timing-evidence.ts`、`cue-boundary-planner.ts`/分隔消费者接入同一个额外候选；完整连续候选段组唯一匹配已接受主文，在词/短句边界使用已验证语义的候选点。拒绝缺失、越界、倒序、退化、词内切点与含错词段的子串。每个源位置恰好消费一次，SRT/LRC 同源；证据不足保留当前原段及可用分隔。

生产每个根窗最多一个额外请求，并与现有恢复互斥；不额外叠加一个分隔请求，不复制离线三个裁窗成本，不硬编码两个示例时间或日文短句。单请求正式参数（包括当前温度回退设置）先验证，与 03E 实验参数差异如实记账。

验证顺序：协议/模式隔离/生命周期与纯规划反例 → 固定开头和 B/B-noise/C 正式字段 → 实际应用全轨及独立序章回归 → 更新人工包。已通过的 12.080/14.840 秒仅作为这两处候选听感参考，不能将其写成通用精度阈值，也不能替代其他切点和整轨的人工验收。下一次交付须说明默认路径实际新增了哪些分句、哪些仍回退；不能只交付另一个离线演示来宣布生产完成。
