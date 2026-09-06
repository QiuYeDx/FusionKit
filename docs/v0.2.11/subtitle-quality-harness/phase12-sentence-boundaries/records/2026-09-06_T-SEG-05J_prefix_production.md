# T-SEG-05J 双观察前缀去重默认接线

2026-09-06，R-SEG-03/04/07，M 单模块串行。按设计 6.20 实施，用户已通过 05I 内容和时间听校，连续推进授权有效。

## 实际结果

新构建实际应用默认 Windows/CUDA、large-v3、日语、VAD 开启，六素材执行完毕。independent 第 10 条由 `のテクノブレイク さすがにショック大きいみたいね` / 52500～61230 ms 改为 `さすがにショック大きいみたいね` / 55880～61230 ms，与用户已验收的实验 SRT 全文一致；前条和其他 30 条不变，总数仍为 31。

opening 12 条、full 66 条、quiet 1 条、control 3 条全部保持，SRT 字节相同；五份有语音输出的 SRT/LRC 均严格读回并逐条核对投影。noise 保持 no_speech_detected，没有字幕文件。新结果复现同一人工验收候选，无需重复听校。102.5/127.5 秒其他重复、开头剩余句界未在本批解决。

## 实现

- `cue-prefix-overlap-evidence.ts` 从已验收离线规则提取同一核心；源关系检查可供计划阶段调用，完整双观察检查的文字、时间门槛不变。benchmark 包装加载此 TS 核心，保留媒体 SHA 验证和 automaticAcceptance:false 合同。
- `cue-prefix-overlap-resolver.ts` 验证相邻根窗、原音观察与拥有区间两条的对应，构造固定两份 20 秒窗口。共享预算函数要求两根窗都没有可选请求，且总请求剩余至少两次。
- `production-executor.ts` 记录首次接受或一次条件化→原音回退接受的根窗；旧可选流程全部执行后才选择至多一处新接缝。两份请求分别计入相邻根窗，每次 freshInferenceState，无增益/无 VAD，沿用 30 秒推理超时。两份完整证据都通过才替换右条；预算不足、证据不符、可选启动或推理失败时保持原字幕；取消/清理错误仍阻止导出。
- 原音身份在生产由 normalized 标识及窗口品牌/响应绑定保证，离线仍核对 SHA；没有把运行时标识伪称文件哈希。没有把人体听感 aligned 当成毫秒级测量，也没有按字数分配起点。

## 验证

203 项 Vitest 通过：productionExecutor 98、cuePrefixOverlapResolver 9、cueOverlapResolver 22、subtitleFormats 25、subtitleExporter 49。新增执行器用例覆盖两次主回退后成功、观察矛盾、缺词点、全局预算不足、第二次启动失败、第二次推理失败、取消、窗口清理失败；计划测试覆盖源关系与局部/全局预算。共享离线前缀 13 项和原完整组 15 项，共 28 项 Node 测试通过；合计 231。

TSC --noEmit 通过；Vite --mode=test 构建及 check-preload-bundle 通过。构建仍提示既有大包和 useModelStore 静态/动态混用。UI/locale 未改，没有扩展 i18n 验证范围。初次测试清理失败夹具误读 brand.windowKey，修正为 brand.descriptor.windowKey 后整组通过；这不是生产行为变更。

实际运行包位于私有目录 `test-results/subtitle-quality-review/phase12/production-prefix-overlap/`，包含 app-report、verification、cleanup-report 和五对正式 SRT/LRC。runner 通过真实 Electron 页面添加六份工作区音频副本并执行实际默认路径，没有注入识别响应。文件系统监测发现 opening/independent/quiet/noise/control/full 分别创建 4/14/1/1/2/12 个唯一推理 WAV。该计数是窗口物化旁证，不是 HTTP 请求抓包；independent 的 14 与 7 根窗可选启动门一致，成组请求准确行为另由执行器测试核实。

本批从首个任务快照到全部终态用时 111644 ms，上一版相同六素材为 99624 ms，相差约 12 秒；新增两份独立观察会产生加载及推理成本，但单次整批差值不能精确归因为纯新增推理耗时。

实际应用 PID 70404 已退出，测试所属进程已清空，专用 app-profile 已核对路径边界和重解析点后删除，释放 5379038909 字节。NAS 三份既有源文件 SHA/大小/mtime 保持；独立工作区原音 SHA 仍为 `9c80350769700f72edc5bd7e7428122f42b1c8eede81967dbe723e5fb7c4fc10`。原始音频和听校附件未修改。

## 状态与后续

本任务完成默认接线和实际验证，代码尚未提交/推送。05H、05I 的既有未提交变更仍在同一工作区；与本任务无关的 reserved-port 避坑文件未动。下一任务先处理 102.5 秒中部包含和 127.5 秒跨多个左父段的来源边界，不直接套用本次仅删除右侧精确前缀的规则。T-SEG-05 整体仍进行中。
