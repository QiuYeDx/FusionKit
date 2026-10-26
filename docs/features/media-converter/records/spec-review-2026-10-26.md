# 规格评审记录（2026-10-26）

| 项 | 值 |
| --- | --- |
| 对象 | docs/features/media-converter 初稿（I1 详细设计，I2–I5 草案） |
| 方式 | 从 5 个视角做对抗式评审：ffmpeg 技术（在随附构建上实测）、代码集成、需求质量、产品体验、安全与许可。每条发现再由独立核查者尝试反驳 |
| 结果 | 共 91 条：确认 61 条，部分成立 30 条，被驳回 0 条。按核查后定级：阻断 1 条，重要 39 条，次要 51 条 |
| 处理 | 91 条已全部并入文档，见下表「处理」列。实测证据保存在评审会话的临时目录中，未入库 |

阻断项 TECH-1：hevc_nvenc 同时使用 `-tune uhq` 与 `-bf 3` 时，驱动拒绝打开编码器，已在本机 RTX 4070 Ti SUPER 上复现。初稿的能力探测只检查 `-tune uhq` 能否被接受，结果会把 uhq 标记为可用，进而让所有 HEVC NVENC 任务失败。

| ID | 定级 | 核查 | 位置 | 处理 |
| --- | --- | --- | --- | --- |
| TECH-1 | blocker | confirmed | module-encode/design.md §3, hevc_nvenc row (line 106); module-engine/design.md §3, uhq … | encode §3 中 hevc_nvenc 拆为 uhq 与 hq 两行，uhq 不设 -bf；engine §3 能力探测改用真实生产参数 |
| INT-1 | major | confirmed | module-workbench/design.md §现状与约束 共用组件 (line 33) and 组件与状态 table row「上传 \| ToolFileDrop… | 上传区改用 ToolFilePickerSurface + 页面级拖放（workbench design） |
| INT-10 | major | confirmed | module-engine/design.md §6 临时文件 (lines 228-229) and §4 成功判定 | 同 TECH-11 |
| INT-2 | major | confirmed | module-workbench/tasks.md V-WORKBENCH-02-2 (line 83, FUSIONKIT_TEST_MEDIA_CAPS), V-WORK… | 新增 engine §9 测试开关模块，加入 T-ENGINE-03/07 的写集，打包后忽略 |
| INT-3 | major | confirmed | module-workbench/tasks.md write sets of T-WORKBENCH-01..04 (lines 27, 63, 95, 125); V-W… | UI 测试文件与 helper 归 T-WORKBENCH-01 所有，后续任务追加场景 |
| INT-4 | major | confirmed | module-engine/design.md 代码落点 table (lines 283-305) and §5; module-engine/tasks.md T-ENG… | 新增 engine §5 执行器与 T-ENGINE-07 真实集成测试，并调整依赖 |
| INT-7 | major | confirmed | module-workbench/tasks.md 依赖 of T-WORKBENCH-02 (line 62), T-WORKBENCH-03 (line 94), T-W… | 修正 workbench 依赖：T-WORKBENCH-02 依赖 T-ENCODE-04，T-WORKBENCH-04 依赖 T-ENGINE-07 |
| REQ-1 | major | confirmed | module-encode/requirements.md AC-ENCODE-06-2 (line 195); module-encode/design.md §7 (li… | 容器标识由 brand、DocType、扩展名共同决定；AC-ENCODE-06-2 补充示例 |
| REQ-11 | major | confirmed | module-engine/design.md §7 channel table (lines 270-271); module-workbench/design.md 开始… | 新增 start.confirmed 与 retry.override（engine §8 通道表） |
| REQ-12 | major | confirmed | module-engine/design.md 代码落点 (lines 283-305); module-engine/tasks.md T-ENGINE-05 (lines… | 同 INT-4 |
| REQ-13 | major | confirmed | module-engine/requirements.md AC-ENGINE-03-2 (line 101) vs module-engine/design.md §3 降… | AC-ENGINE-03-3 与设计统一为：首包前失败即降级，并重新生成计划 |
| REQ-14 | major | confirmed | module-encode/design.md §3 HEVC table libkvazaar row (line 110); AC-ENCODE-02-5 (line 9… | 同 TECH-4 |
| REQ-15 | major | confirmed | module-encode/requirements.md AC-ENCODE-01-4 (line 54); module-encode/tasks.md V-ENCODE… | 同 TECH-8；V-ENCODE-01-3 用真实 remux 结果比对 |
| REQ-16 | major | confirmed | module-encode/requirements.md AC-ENCODE-04-2 (line 147) | 同 TECH-16 |
| REQ-17 | major | confirmed | module-encode/requirements.md R-ENCODE-02 (ACs 02-1…02-5); brd.md success condition 1 (… | 新增 AC-ENCODE-02-6 校准阈值，并从任务中移除阈值 |
| REQ-19 | major | confirmed | module-workbench/tasks.md V-WORKBENCH-02-2 (line 83), V-WORKBENCH-04-1 (line 146); modu… | 同 INT-2 |
| REQ-2 | major | confirmed | module-encode/requirements.md AC-ENCODE-05-1 (line 172) and boundary (line 177); module… | 转换任务只判断编码是否兼容；压缩任务另判断码率（AC-ENCODE-05-1） |
| REQ-3 | major | confirmed | module-encode/design.md §1 (line 30), §2 note (line 54), §3; AC-ENCODE-01-3 (line 53); … | 新增 AC-ENCODE-01-7：转换任务按目标容器选择编码（见 §2 表） |
| REQ-4 | major | confirmed | module-workbench/requirements.md AC-WORKBENCH-02-3 (line 74); brd.md BR-01 验收要点 (line 7… | 新增 AC-ENCODE-01-6：任务 × 媒体类型矩阵 |
| REQ-5 | major | confirmed | module-encode AC-ENCODE-04-2 (line 147) and design §5 (line 187) vs design §1 Conversio… | 计划改为 outputs[]，多个输出逐一发布，增加部分完成状态，并补测试 |
| REQ-6 | major | confirmed | module-engine/requirements.md AC-ENGINE-04-4 (line 133); module-engine/design.md §4 sta… | 同 TECH-12 |
| REQ-7 | major | confirmed | module-engine/requirements.md AC-ENGINE-04-5 (line 134) and R-ENGINE-02 boundary (line … | AC-ENGINE-04-5 定义预期时长；无法确定时附 duration_unverified |
| SEC-1 | major | confirmed | module-engine/design.md §2 (lines 62, 83: probe command and container allowlist applied… | ffprobe 与输入加 -format_whitelist，每个 -i 前固定 -f；按扩展名预先拒绝；补哨兵测试 |
| SEC-3 | major | confirmed | module-engine/design.md §6 publish (line 234); requirements.md AC-ENGINE-06-2 (line 187… | link 遇到 EEXIST 以外的错误时一律回退；清理占位文件；FAT 卷按文件大小核对 |
| SEC-5 | major | partially | module-encode/design.md §7 estimateUpperBoundBytes (line 218: compress = source size); … | 每个输出加 -fs/-t 上限；按卷预留空间；触顶语义 |
| TECH-10 | major | confirmed | module-encode/requirements.md AC-ENCODE-04-3 (line 148); module-encode/tasks.md V-ENCOD… | AC-ENCODE-04-3 改为「源容器品牌标签不写入 MP3/FLAC/Opus」；去掉 -metadata encoder= |
| TECH-12 | major | confirmed | module-engine/design.md §4 stall watchdog (line 160); AC-ENGINE-04-4 | 停滞判定分阶段，收尾阶段单独给预算（AC-ENGINE-04-4、engine §4） |
| TECH-13 | major | confirmed | module-engine/design.md §2 HDR second probe (lines 65-69, 78); module-engine/requiremen… | 杜比视界改从流级侧数据识别，兼容 id 为 0 也按 P5 处理（AC-ENGINE-02-2、AC-ENCODE-03-4） |
| TECH-2 | major | confirmed | module-engine/design.md §3 probe command (line 105) and degradation rule (line 125); mo… | engine §3 由 probeArgs 生成真实参数，日志级别改为 level+warning，探测输出 MKV 后用 ffprobe 核对；AC-ENGINE-03-3 改为首包前失败即降级；新增 NVENC 尺寸前置条件 |
| TECH-3 | major | confirmed | module-encode/design.md §3, h264_mf/hevc_mf rows (lines 109, 119-120) and §4 `format=` … | MF 输入改为 nv12，h264_mf 加 -profile:v 100；新增像素格式表；能力探测中的 MF 也用 nv12 |
| TECH-4 | major | confirmed | module-encode/design.md §3, libkvazaar row (line 110) | kvazaar 参数改用逗号分隔；V-ENCODE-02-2 检查三档体积递减、日志中没有 Invalid option |
| TECH-5 | major | confirmed | module-encode/design.md §3 HEVC chain (line 110), §4 scaling and odd-dimension rules (l… | kvazaar 输出尺寸取 8 的倍数（AC-ENCODE-02-2/02-3、§3、§4）；新增 854×480 与 1920×804 夹具 |
| TECH-6 | major | confirmed | module-encode/design.md §4 filter chain (lines 143-148) and colour bullet (line 151); A… | 全范围源一律经 scale in_range=pc:out_range=tv 转换（AC-ENCODE-03-2、§4）；实测检查 YMAX |
| TECH-7 | major | confirmed | module-encode/design.md §5, channel layout bullet (line 180) and in-video audio (lines … | 新增 Opus 标准布局表；每条音轨各用一个 -filter:a:N（AC-ENCODE-04-4、§5） |
| TECH-8 | major | confirmed | module-encode/requirements.md AC-ENCODE-01-4 (line 52); module-encode/design.md §2 disp… | AC-ENCODE-01-4 按容器分别规定；MP4 改写 handler_name；新增 mp4_default_subtitle_forced 警告 |
| TECH-9 | major | confirmed | module-encode/design.md §2 compatibility matrix, MKV row (line 51) and AC-ENCODE-01-3 | 输出 MKV 时 mov_text 与 eia_608 转为 srt（AC-ENCODE-01-3、§2） |
| UX-1 | major | partially | spec.json decisions Q-01; brd.md 背景 + 成功条件 1; README.md 待用户决定 Q-01 | Q-01 改为陈述事实并增加选项 B/C；验收增加真实设备播放 |
| UX-2 | major | confirmed | module-encode/design.md §6 输出命名 (压缩视频 → 简单模式为 .mp4) and §2 MP4 row; AC-ENCODE-01-3; Con… | 压缩输出格式改为 自动/MP4/MKV；新增 subtitle_styling_lost（A-08） |
| UX-5 | major | confirmed | brd.md 成功条件 4; spec.json A-05; module-encode/design.md §3 (后台模式附加 lp=2); AC-WORKBENCH-0… | 低占用模式改为 CPU 亲和性 + IDLE + lp=1，更名，并在验收中实测 |
| UX-8 | major | confirmed | module-encode/design.md §3 (av1_amf / hevc_amf / h264_amf rows); AC-ENCODE-02-5; V-ENCO… | QSV/AMF 给出暂定值并注明待确认；快照覆盖仅 AMF 的情况；README 写明 I1 只校准 NVENC |
| INT-11 | minor | confirmed | module-workbench/design.md 视觉参照 「图标：lucide `Clapperboard`（备选 `FileVideo2`）」 (line 79) | 图标改为 FileVideo2，备选 Film |
| INT-12 | minor | confirmed | module-engine/design.md §7 `add-dropped-files` → `{added, duplicates, rejected}` (line … | 定义拖放拒绝码（folder_not_supported / not_a_regular_file / file_unavailable / temporary_copy_unresolved）并补测试 |
| INT-13 | minor | partially | module-workbench/tasks.md T-WORKBENCH-01 实现要点 「只有在无法用 as const 映射时，才更新 manifest 选择器，例如磁… | i18n 清单登记改为必做步骤（T-WORKBENCH-01、V-WORKBENCH-01-2） |
| INT-5 | minor | partially | src/media-converter/contract.ts ownership: module-engine/tasks.md T-ENGINE-01 (line 21,… | contract.ts 的原因码一次性定义为封闭枚举；PlannerCapabilities 由 T-ENCODE-01 定义 |
| INT-6 | minor | partially | module-encode/tasks.md T-ENCODE-02 (依赖 line 52, 写集 line 53) vs T-ENCODE-04 (依赖 line 123… | encode 任务改为串行；args.ts 与 stream-plan.ts 加入后续任务的写集 |
| INT-8 | minor | confirmed | module-workbench/design.md §注册与目录 (lines 183-187) and §测试约束 line 23 | MEDIA_TOOLS 的声明放在 EXPERIMENTAL_TOOLS 之后、type FeaturedItem 之前（workbench design） |
| INT-9 | minor | partially | module-workbench/requirements AC-WORKBENCH-01-2 / design §注册与目录 (「App.tsx：添加路由，supporte… | macOS 改为页内显示「平台不支持」，不再跳转；V-WORKBENCH-01-3 运行 tool-navigation 测试 |
| REQ-10 | minor | partially | module-engine/requirements.md AC-ENGINE-06-4 (line 189); module-encode/design.md §7 est… | 新增 disk_full 与 file_too_large_for_volume；磁盘预检改按输出上限计算 |
| REQ-18 | minor | partially | spec.json decision A-07 (line 195); module-encode/tasks.md T-ENCODE-05 (lines 157-158, … | A-07 写明只阻断校准与 I1 验收，并给出替代方案；AC-ENCODE-06-1 改由执行器测试覆盖 |
| REQ-20 | minor | partially | module-engine/requirements.md AC-ENGINE-07-2 (line 213); module-workbench AC-WORKBENCH-… | 拖放封装：整批被拒时，非临时路径重新放行（AC-ENGINE-07-2） |
| REQ-21 | minor | partially | module-engine/requirements.md AC-ENGINE-01-3 (line 47); module-engine/design.md §1 (lin… | 所有平台都注册通道，darwin 下统一返回 platform_unsupported（AC-ENGINE-01-3） |
| REQ-22 | minor | confirmed | module-engine/requirements.md AC-ENGINE-04-2 (lines 125-131), AC-ENGINE-04-3 (line 132)… | 推送频率并入 AC-ENGINE-05-1；macOS 信号处理移到 R-ENGINE-09 |
| REQ-23 | minor | confirmed | module-engine AC-ENGINE-01-2, 04-1, 05-1, 05-5; module-workbench AC-WORKBENCH-01-1, 01-… | 补齐各检查项的测试用例，并给出「批次」的定义 |
| REQ-24 | minor | partially | module-workbench/tasks.md T-WORKBENCH-02 deps (line 62), T-WORKBENCH-04 deps (line 124)… | 同 INT-7；快照中提供 resolvedEncoders |
| REQ-25 | minor | confirmed | brd.md BR-02 (line 105), BR-04 (line 163); README 压缩技术要点; module-encode AC-ENCODE-04-1 … | 统一 98% 阈值、FLAC 5/5/8、提取支持 ALAC；I1 不开放并发；队列选项由主进程管理；超过目标的文件不发布 |
| REQ-26 | minor | confirmed | module-encode/design.md §3 H.264 table h264_mf rows (lines 119-120) vs AC-ENCODE-02-4 (… | 同 TECH-3 |
| REQ-27 | minor | confirmed | module-engine/design.md §6 临时文件 (lines 228-229) | 同 TECH-11 |
| REQ-28 | minor | confirmed | module-engine/requirements.md AC-ENGINE-03-1 (line 100) vs module-encode AC-ENCODE-02-2… | 能力探测增加 h264_mf 软件编码 |
| REQ-29 | minor | confirmed | module-engine/requirements.md AC-ENGINE-07-2 (line 213) vs module-workbench AC-WORKBENC… | 错误日志在主进程脱敏（AC-ENGINE-07-3） |
| REQ-30 | minor | confirmed | module-engine/design.md 文件身份 (line 22), §6 启动清理 (line 242); AC-ENGINE-05-3, AC-ENGINE-0… | FileId 全零视为未知，改用兜底比较；未挂载卷的临时文件记录保留 |
| REQ-8 | minor | partially | module-engine/requirements.md AC-ENGINE-06-2/06-3 (lines 187-188); module-engine/design… | 同批同名文件自动编号（output_name_collision）；覆盖选项不持久化（AC-ENGINE-06-3） |
| REQ-9 | minor | partially | module-engine/requirements.md R-ENGINE-05 (AC-ENGINE-05-3, line 158); module-engine/des… | 运行前再次核对输入身份，区分 input_missing 与 input_changed（AC-ENGINE-05-3） |
| SEC-10 | minor | partially | module-engine/design.md §4 stall watchdog (line 160); requirements.md AC-ENGINE-04-4 (l… | 首包前设宽限期（低占用模式 600 s），停滞判定分阶段 |
| SEC-11 | minor | partially | module-encode/design.md §6 naming (lines 208, 211); module-encode/tasks.md V-ENCODE-01-2 | 命名清洗：lang 校验、bidi 字符、保留名、按码点截断、output_path_too_long |
| SEC-12 | minor | confirmed | module-engine/requirements.md AC-ENGINE-07-2 (line 213); module-workbench/requirements.… | 同 INT-12 / REQ-20 |
| SEC-13 | minor | partially | module-engine/design.md §4 (line 139 crash-kill claim, line 165 macOS cancel); requirem… | 崩溃时子进程自动结束只在 Windows 成立；macOS 孤儿进程与 SIGKILL 移到 R-ENGINE-09 |
| SEC-2 | minor | partially | module-engine/design.md §6 (lines 228–229 create .partial + `-n file:<partial>`, line 2… | 同 TECH-11；记录中保存身份；明确清理规则；清空 work 目录 |
| SEC-4 | minor | partially | module-engine/design.md §6 overwrite (lines 235, 238); module-encode/design.md §6 namin… | 覆盖前先把旧文件移入回收站，开始前确认清单；同批同名自动编号 |
| SEC-6 | minor | partially | module-engine/design.md §1 trade-off (line 53: 「许可边界不变」); brd.md I5 / R-WORKBENCH-08; s… | 新增 Q-04（QA-005 与专利）；engine §1 写明取舍 |
| SEC-7 | minor | partially | module-engine/design.md §7 (line 277: 「渲染进程只能看到 displayName 和 folderName」), §5 persiste… | 日志脱敏；state.json 只保存 16 KB 尾部 |
| SEC-8 | minor | confirmed | module-engine/design.md §3 cache and failure table (lines 112–123); requirements.md AC-… | 只持久化确定的结论；总预算 30 s；有任务在运行时禁止重新检测 |
| SEC-9 | minor | confirmed | module-engine/design.md §3 probe command (line 105); module-encode/design.md §3 hevc_mf… | 同 TECH-3 |
| TECH-11 | minor | partially | module-engine/design.md §6 temporary file (lines 228-229); AC-ENGINE-06-1 | 临时文件流程改为：记录 → wx 占位 → -y 写入 → 核对身份（AC-ENGINE-06-1、engine §7） |
| TECH-14 | minor | confirmed | module-engine/design.md §4 common argument prefix (line 146) vs module-encode/design.md… | 统一使用 -loglevel level+warning；测试中出现指定警告模式即判失败 |
| TECH-15 | minor | confirmed | module-encode/design.md §3 encoder rows (lines 81-121), libopenh264 in particular | 非 SVT 编码器的 GOP 统一约 5 s（§3、AC-ENCODE-02-4） |
| TECH-16 | minor | confirmed | module-encode/requirements.md AC-ENCODE-04-2 ('pcm→.wav', line 147); module-encode/desi… | PCM 提取映射：小端 → wav，大端 → aiff，蓝光/DVD PCM 无损转 wav（AC-ENCODE-04-2） |
| TECH-17 | minor | partially | module-encode/requirements.md AC-ENCODE-04-3 ('目标格式会丢章节时（FLAC、WAV、OGG）', line 148) | 会丢章节的格式改为 FLAC、WAV、Ogg Vorbis；Opus 与 MP3 保留章节 |
| TECH-18 | minor | confirmed | module-encode/design.md §4 `format={yuv420p\|yuv420p10le\|p010le}` step (line 146) and … | §4 新增编码器到像素格式的对照表；av1_nvenc 改用 p010le |
| TECH-19 | minor | confirmed | module-encode/design.md §8 VMAF scoring step 2 (line 239) | §8 统一评分分辨率；参考帧同样经过 bwdif/裁剪；按评分分辨率选模型 |
| TECH-20 | minor | confirmed | module-encode/design.md §3 libopenh264 row (line 121) and §7 estimateUpperBoundBytes 'c… | openh264 码率上限为源视频码率的 0.7 倍；修正输出上限公式（§7） |
| TECH-21 | minor | confirmed | module-engine/design.md §4 long argument handling (line 176) | 超长单流滤镜改用 -/filter:v:0 <file>；-/filter_complex 只用于多输入（engine §4） |
| UX-10 | minor | partially | module-workbench/design.md 组件与状态 (队列 MediaQueueRow, 进度 Progress, 上传 ToolFileDropZone) | 改用 ToolFilePickerSurface；队列行基于 StudioTaskQueueRow；进度条用原生 progress |
| UX-11 | minor | confirmed | module-workbench/design.md 视觉参照 (--tool-media) | 工具色改为品红（色相 335） |
| UX-12 | minor | partially | R-WORKBENCH-02/03/04 (states); module-workbench/design.md 组件与状态 | 补齐状态表：检测中禁用、设置冻结说明、一键切换任务、文件夹提示、aria-live |
| UX-13 | minor | partially | brd.md BR-04 平台预设; module-encode/design.md §9 预设; module-workbench format.ts (体积格式化) | I2 预设加入微信、QQ、QQ 邮箱，按 1024 进制显示，以字节为准 |
| UX-14 | minor | partially | brd.md BR-05 预览对比; R-WORKBENCH-06; R-WORKBENCH 范围外 (视频播放器) | I2 增加「播放样片对比」，并收窄「范围外」的表述 |
| UX-3 | minor | partially | module-workbench/design.md 组件与状态 (处理计划 row); T-WORKBENCH-04 实现要点; brd.md BR-01 + 成功条件 2 | 新增 AC-WORKBENCH-03-6：行内显示损失提示，开始前确认，可改为 MKV |
| UX-4 | minor | partially | brd.md BR-05 (目标分数初值); module-encode/design.md §8; T-ENCODE-05 实现要点 (校准目标) | 目标分数改为 96/94/91；校准阈值写入 AC-ENCODE-02-6；写明 I2 默认是否启用搜索 |
| UX-6 | minor | partially | AC-WORKBENCH-03-2 / 03-3; module-encode/design.md §1 ConversionSettings (convert) and §2 | 默认值写入 AC（分辨率保持原始、转换目标 MP4）；帧率上限放到 I3 |
| UX-7 | minor | partially | module-workbench/design.md 布局与空间 (窄屏) and 内容与验收样本 (视口); V-WORKBENCH-02-2/03-2/04-2 | 窄屏时主区在上；视口增加 1080×786 与 786×540；面板过高时折叠 |
| UX-9 | minor | confirmed | AC-WORKBENCH-03-2 (输出编码); brd.md BR-02; AC-WORKBENCH-03-5 (处理计划·编码器) | 选项按用途命名，附三句兼容说明；编码器显示友好名称；补显卡开关 Tooltip |
