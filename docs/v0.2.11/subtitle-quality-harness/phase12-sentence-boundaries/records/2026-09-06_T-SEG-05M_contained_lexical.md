# T-SEG-05M 中部包含与已确认额外词听校

2026-09-06，R-SEG-03/04/07，M 单模块串行，按 6.23 实施。

## 提交与结果

先按用户要求将 05H～05L 源码、测试和文档本地提交为 `2a1fbb4`（24 文件）。未推送。音频、听校附件、test-results 与无关 reserved-port 避坑文件均不在提交中。

本轮零新增识别，使用 05K 保存的 95～115 / 94～114 秒原音响应、实际 05L 的 30 条 SRT 和已确认 absent 附件。新增离线审计绑定人工标签的媒体、源全文、字素范围、附件 SHA 和 reviewId，再核对两个局部完整 token 切点。标签只供听校实验，输出恒 automaticAcceptance:false / actualApplicationOutput:false，不修改默认消费者或请求预算。

生成三条实验：96170～100860 ms `毛も耳の女の子がいるんだけど`；100860～104740 ms `その子は魔力過剰症といって`；104740～109930 ms `強大な魔力を持っているがゆえの発作に苦しんでいるわ`。只删除左条已确认的“今日は”和重复的一份中部短句，其余正文保持。30 条总数不变，其他 27 条逐条相同，包括 55880 ms 前缀修复及 133200 ms 多父段换句。

两份时间证据分别为 100860/100820 和 104740/104740 ms。这是 DTW 点的重复观察一致性，不是 40 ms/0 ms 精度证明。首条起点 96170 保留；毛も耳／ケモ耳、い／言的差异和窗口外上下文全部保留在记录中，未将局部匹配说成全文相符，未自动纠正异文。

## 验证

22 项新听校审计 + 9 项既有来源审计，共 31 项 Node 测试通过。覆盖人工标签绑定、不同原音、缺词点、坏时间、插词、真实重说、矛盾额外词、不同起点、过短字幕和 token 内切点。初次真重复反例发现仅两端锚点唯一不足以排除中间重说，补充后续短语开头必须全窗唯一后通过；规则补充已回写设计。

实验 SRT/LRC 通过实际格式器导出和严格回读；整轨其他条目完全保持。原音 SHA 与已验收媒体相同，附件 SHA 与既有归档相同；NAS 未写入。本轮仅 benchmark 和实验页面，未修改生产/locale，未重复运行上一阶段 269 项和应用六素材并冒充本轮证据。

听校页桌面及窄屏截图已目视检查，无横向溢出。101 秒显示独立短句，104.8 秒显示后续完整正文；95～111 / 99～106 两个按钮均自动停播，四倍静音 QA 分别停在 111.697 / 106.088 秒。三项默认未判断、下载名称及 schema/media/reviewId/精确候选起止通过；QA 下载仅为合成答案。临时浏览器已关闭，进程扫描无残留。

## 交付与待验收

私有目录 `test-results/subtitle-quality-review/phase12/contained-lexical-review/` 包含 review.html、review-data.json、实验字幕、verification、review-ui-report 和截图。导出文件为 asmr-contained-lexical-listening-annotations.json，schema 为 fusionkit-contained-lexical-listening-v1。仅请求核对本次内容完整性及两个新切点，不再重复询问“今日は”是否存在。

reviewId：`63be0a1edf3363be10ad758183fa074f91d45789aa29a8c4e4c3484a39785a0a`。媒体 SHA：`9c80350769700f72edc5bd7e7428122f42b1c8eede81967dbe723e5fb7c4fc10`。

05M 的审计和实验材料完成，新分句人工验收待返回，任务仍进行中。下一步依据反馈确定包含关系且有额外误识别时的生产资格和请求预算；人工本例标签不能直接写入通用运行时。T-SEG-05 整体仍未完成。本轮新修改尚未提交。


## 2026-09-06 人工结果回收（更新上述待验收状态）

用户提交 asmr-contained-lexical-listening-annotations.json，导出于 2026-09-06T08:53:56.421Z。整体内容 judgment=resolved，100860～104740 ms 与 104740～109930 ms 两项 timing=aligned，note 为空。schema、媒体 SHA、reviewId、条目数、精确短语/起止均匹配，重新计算 review-data 内容摘要一致。

附件 SHA-256：`eae4d6e612b9dae945bbb3c63dae6bdc607b75673fb25fc99fa49013d8cf0f3e`。原件按字节归档至私有 contained-lexical-review/user-listening-annotations.json，验证报告 user-listening-validation.json，校验脚本 test-results/phase12-contained-lexical-listening-validation.mjs。未将 QA 下载用于验收，未修改 Downloads 原件或 NAS。

05M 的实验内容及两个内部切点人工验收完成。确认范围为保留一次中部短句、去掉已确认额外词及本次两个切点；首条 96170 ms 仅沿用旧值，不扩展为其精确起点验收，也不扩展为毛も耳／ケモ耳、い／言词汇修正的认可。

下一步生产化须补足机器可验证的额外词处理依据：本轮离线工具依赖媒体和源字素范围绑定的人工标签，不能把该标签、具体“今日は”或样本时间写死到运行时。完整保留候选异文和反例，设计成组预算，确保已上线 55880/133200 ms 修复优先保持；只有新默认实际复现已验收版本、其他样本回归保持后，才能声明默认修复完成。已验收同一候选不重复听校。当前默认输出未改，本次无新推理或提交。
