# T-WORKSPACE-08 文档库与批量体验改进

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-08 |
| 日期 | 2026-09-11 |
| 授权 | 当前任务用户要求在 I2 前改善异常文档、多文件处理和预览按钮，见 spec.json I1 approval；本次不进入 I2、不发布 |
| 验证版本 | v0.3.1，b68477a 加本轮工作树；未提交 |
| 任务指纹 | 04e4bdb237f4a92ca007b80a1afd788a6eab45610f28f37443c3b67bfd030d35 |
| 集成 | root 负责文档库/异常UI、偏好、规格与验证；backend_audit 负责仓库/IPC/批量服务；ux_audit 负责翻译/导出组件和四语言；batch_verification 负责新开发版Electron场景。共享写集经root协调，服务只由root启动 |
| 环境 | Windows x64，既有 Node/TypeScript/Vite/Electron/Playwright；沿用 lockfile，未安装或升级依赖 |

## 实际结果

对应唯一需求 R-WORKSPACE-09。异常不再只有一个不可处理的数量：文档库保留“待处理”入口，能查看标识、应用保存目录、在文件夹中显示和显式清除。提示关闭按异常集合指纹持久化；异常变化会重新出现。清除重读对象并验证稳定令牌，已恢复或已变化的文件拒绝陈旧清除；源文件/导出文件不属于清除范围。

原生多选导入最多100份、逐项失败隔离；批量导入不会接连自动弹双语整理。文档库全局名称查询、格式/状态筛选、名称/更新时间/字幕数排序，然后按20份分页。支持数字跳页、本页/全部匹配结果选择，跨页选择独立于右侧预览。搜索和筛选变化会清空选择，待加载期间禁用旧列表的批量选择；排序/翻页保留。列表显示译文及任务状态。

批量翻译共用一次配置和预算检查；新增计划缓存与单文件计划分开，逐项校验修订、创建持久任务并显示结果。继续复用请求级 FIFO 和最大2个请求的调度，不承诺整文档串行。可对所选文档批量取消/继续/删除；继续仍使用原任务设置与已配置的同一模型，不自动替换模型。

下载按钮合并为菜单：原文件与字幕导出；预览整理/翻译/下载/删除采用一致的 ghost/icon-sm 与可读名称。批量原文件下载和字幕导出仅选择一次目录，逐文档译轨、统一格式/编码/缺失策略及损失确认。主进程仅保留有界计划元数据，逐项重建输出并校验修订/摘要，同名原子编号且不覆盖。单文件冻结修订的既有语义保留。

## 发现、修复与复验

1. 原计划准备会 `forgetOwner`，直接循环单文件准备会作废前面计划。新增批量计划缓存，既有单文件接口保持兼容；服务测试覆盖两类计划互不替换、过期/越owner/撤销/重复并发执行。
2. 第一轮开发版Electron在导出中被并行实现触发的开发重载中断。此轮不算通过；冻结生产文件后重新运行完整场景。
3. 恢复测试最初误把后文上下文中的下一句当作当前请求，导致首批也挂起。改为只匹配实际待译 `items` 并等待真实持久提交后杀隔离进程；保留“存在已提交字幕且恢复不重发”的断言。
4. 代码审查发现跨1024px布局切换会卸载库内批量控制器。把控制器和对话框常驻页面根部、触发器portal进入文档库，结果不随布局或配置事件丢失；Electron增加1280→786→1280结果保持验证。
5. 搜索防抖期间旧列表仍可选择，已改为待查询时锁定旧列表动作；窄窗库/结果弹窗显式聚焦搜索/关闭按钮。
6. 实际截图审查修正本页部分选择的横杠表现，并移除正常SRT批量导出的无关结束时间估算段。正常/选中/长名称/打开下载菜单/恢复确认/深浅主题与窄窗实际查看；没有用截图生成或元素存在替代审阅。
7. 构建发现 Playwright 属性选择器拼接 `:visible` 被 Tailwind 自动扫描为任意变体，产生无效CSS警告。改为按aside范围定位已有testid，再次构建该警告消失；未扩大修改Tailwind全局扫描规则。新旧构建仍有既有大chunk及模型Store混合静态/动态导入提示。
8. 原有工作区测试使用全页“下一页”，新增文档库分页后出现定位歧义；改为限定字幕预览区域，保留原分页断言。单选无效文件仍使用原有就地错误与重试反馈，不清空当前查询和选择；多选部分失败使用逐项结果。最终构建后的工作区完整场景复验通过。

## 验证结果

模块回归333项通过、18项按环境开关跳过；其中开发版场景另行显式执行，不计作未验证。最终四语言locale/usage通过（18条既有同值提示），两套TypeScript、根Vite构建、preload检查和ready/approval规格检查通过。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-08-1 | 通过 | inline: 仓库26、IPC19、查询3、批量7、翻译35、恢复25、独立边界2，117个不同针对性测试已通过；全模块333项通过。日志 test-results/studio-library-suite.log |
| V-WORKSPACE-08-2 | 通过 | inline: 最后视觉修正后开发版完整场景46.01s、既有开发导入16.98s均通过，最终截图已亲自审阅；详情见 test-results/studio-library/evidence.json 与 studio-library-electron-final.log |
| V-WORKSPACE-08-3 | 通过 | inline: 最终两套TypeScript exit0，i18n264个studio键四语齐全/源码1972已解析键通过，根Vite test构建及Sandboxed preload external module check通过，git diff --check通过，ready/done --require-approval 0 error/0 warning；日志 studio-library-i18n.log、studio-library-build.log、studio-library-spec.log |
| V-WORKSPACE-08-4 | 通过 | inline: 全模块333通过；构建版双语整理16.995s、导出42.829s、翻译13.989s、删除恢复21.269s通过，修正分页定位后工作区单独重跑36.306s通过。日志 studio-library-single-ui.log（保留首轮4过1失败）、studio-library-workspace-ui.log（最终通过）；清理审计 studio-library-cleanup.json 显示本轮Electron/Vite进程为空、7777无监听 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-09-1 | 通过 | V-WORKSPACE-08-1, V-WORKSPACE-08-2 |
| AC-WORKSPACE-09-2 | 通过 | V-WORKSPACE-08-1, V-WORKSPACE-08-2, V-WORKSPACE-08-4 |
| AC-WORKSPACE-09-3 | 通过 | V-WORKSPACE-08-1, V-WORKSPACE-08-2 |
| AC-WORKSPACE-09-4 | 通过 | V-WORKSPACE-08-1, V-WORKSPACE-08-2, V-WORKSPACE-08-4 |
| AC-WORKSPACE-09-5 | 通过 | V-WORKSPACE-08-1, V-WORKSPACE-08-2, V-WORKSPACE-08-4 |
| AC-WORKSPACE-09-6 | 通过 | V-WORKSPACE-08-2, V-WORKSPACE-08-3, V-WORKSPACE-08-4 |

开发版场景：41份有效文件和1份无效文件一次选择，成功库3页；跨页2份批量翻译后目标SRT导出2份，原有同名文件保留，删除2份后39文档；异常关闭跨重启保持、管理定位和显式删除隔离残留；两文档首批提交后崩溃，显式批量继续不重发2条已提交字幕；另两份取消后迟到响应不能改写。10次模型请求全部为本机loopback fixture；41份外部源文件字节保持，页面异常为空。

截图在 test-results/studio-library/：library-cross-page-selection-desktop、preview-actions-desktop、unified-download-menu-desktop、batch-export-plan-desktop、batch-export-results-after-narrow-switch、recovery-management-desktop、batch-resume-confirmation、batch-cancelled-desktop、library-narrow-dark-workspace、library-narrow-dark-management。早先 failure.* 为已解释失败过程，不作为最终证据。

最终共333项模块测试和7个显式Electron场景通过（2个开发版、5个构建版，不将跳过项计为通过）。2026-09-11 01:17 +08:00 只读进程与端口审计无残留；root已关闭自有开发服务，测试隔离资料由各场景finally回收。删除本轮类型检查生成的未跟踪tsconfig.node.tsbuildinfo；未清理真实用户资料。本轮Vite为test模式构建，不是发布安装包。

## 风险与未执行项

目录选择/系统定位在测试中只控制OS对话框返回或记录shell调用，仍使用真实preload/main和磁盘；不是人工点击Windows原生对话框。没有真实供应商联网，也没有进行I2转写或重新执行旧版ASR。没有清除或迁移真实用户资料；原有坏文档由用户在新增管理入口自主处理。

列表仍按完整仓库扫描后筛选分页，20份DOM页面与100份批次上限不等于已验证海量文档库性能。双语整理继续逐份人工确认，避免对语义不明确的字幕做隐式批量重写。用户最终整体验收仍为pending，Agent不代签。

## 2026-09-11 全选范围与复选框对齐跟进

来源为用户在本任务继续指出“全选复选框与每行不在同一竖线、全选只选当前页”。对应既有 AC-WORKSPACE-09-3/6 内的体验改进，保持 T08 / I1 范围；未提交且未进入 I2。root 实现和验证，selection_review 只读审查，保留前轮工作树。

顶部原为10px内边距，而行内是列表8px加复选框8px，实际差6px。用共享选择列间距统一实际起点，正文标签也与文件名起点一致。主checkbox现在跨页全选匹配范围；菜单的“选择本页”为幂等添加，不反向清空；保留全局清空。后台状态变化时通过前后端共用 matchesLibraryQuery 计算范围，取消当前范围不清除移出筛选的已选项；全选有界重试并校验合并后的100份上限，所有菜单动作受busy约束。超限保留原选择，在文档库内部提示，窄窗同样可见且可关闭。

验证：3项查询服务及2项边界测试通过；最终TypeScript通过；四语言270个studio键一致，源码1978个已解析键通过，保留18条既有同值提示。真实开发版完整 library-ui 最终51.392s通过，日志 test-results/studio-selection-electron-complete.log；包含41份三页全选、40份部分选中/补齐/空格取消、幂等本页20份、筛选范围、批量翻译/导出/取消/恢复/删除、窄窗39份全选，以及101份边界保留原39份勾选。未使用真实供应商API，仍为10次loopback请求，41份外部源文件字节保留。

几何验证在同一DOM帧采样，保留0.5px容差；桌面headerX与rowX均49，窄窗进场中均163.633865（祖先缩放影响绝对尺寸，但同列关系不变）。截图 selection-all-pages-desktop、selection-options-desktop、library-narrow-dark-management 已亲自查看。首次尝试用Playwright check()假设全选同步完成，改为click后等待IPC结果；另一轮先后两次量框跨越弹窗缩放帧，改为同帧测量；101份fixture最初重复同一路径被正确去重，改为62份不同路径文件。保留既有状态/几何断言，没有用放宽阈值或减少文档数获得通过。

最后截图审查发现窄窗旧的上限提示与新库内提示重复，已移除旧段。最终根Vite test构建、preload检查和构建版受影响区域复验通过：101份库只显示1条可关闭的上限提示，搜索匹配的41份跨3页全部选中；稳定窄窗headerX与全部20行rowX均155.5、宽16，pageerror为空。最终截图 test-results/studio-selection-final/narrow-limit-single-notice.png、narrow-filtered-all.png 已亲自查看；证据同目录evidence.json，构建日志studio-selection-final-build.log。2026-09-11 15:53 +08:00 进程审计为空，7777无监听（studio-selection-cleanup.json）。该局部修正未重跑无关的旧单文件5项流程，前轮证据保留历史含义。规格done/approval及git diff --check通过；经验更新FK-PIT-0127/0128。

## 2026-09-11 文档库行高亮与固定底栏跟进

用户继续提供三张截图，要求改善搜索/选择/列表边距，合并hover/当前预览/多选的嵌套高亮，并将顶部突然出现的两层批量操作卡片改为底部紧凑单行。本轮对应 AC-WORKSPACE-09-3/6 的局部优化，未扩展批量上限或 I2。root 负责实现、四语言和验证，library_layout_review 只读设计评审后独占修改 library-ui.test.ts，交回写权后冻结源码进行验证；前轮改动全部保留。

最终采用已有分页footer的一行槽位，固定45px含边框和8px上下留白：未选择显示文档范围和分页，已选择显示短计数、翻译、下载、更多以及compact分页，数字跳页仍可达。更多包含继续/取消/删除/清空，并处理菜单到确认弹窗的焦点交接。按钮仅在本库footer局部缩为28px，不改变其他共享按钮或业务控制器生命周期。搜索框和行表面同为12px外边距，checkbox和文本分别20px/44px；li统一绘制状态背景，移除旧button hover/current背景，保留当前预览勾号和整行键盘焦点。无新增依赖、无真实用户数据写入。

最终TypeScript及i18n通过（271个studio键四语言一致、1979个源码已解析键，18条既有同值提示）。真实开发版完整library-ui首次执行即61.330s通过，日志test-results/studio-footer-electron.log。测试覆盖0/1/2/41选择时footer高45、列表top和height及scrollTop不变；desktop/narrow同帧测得12/20/44px对齐；验证内层button背景透明且无shadow、仅外层统一高亮，三行分别为current+selected、selected、hover并保留4px间隔。继续覆盖原有批量翻译、目录导出、取消/重启恢复、选择101份超限反馈、跨断点保留结果。10次模型请求仍为本机fixture。

已亲自查看最终开发版截图library-unified-row-states-desktop、library-fixed-footer-menu-desktop、library-narrow-dark-management：新操作区占用现有底栏，不再挤动正文；高亮包含checkbox与预览区域且无内层叠加。相关几何数据新增在test-results/studio-library/evidence.json的layout字段。未重复其他未受影响模块的全量测试。

最终根Vite test构建与Sandboxed preload external module检查通过，日志test-results/studio-footer-build.log。构建版另外导入100份隔离字幕，在简中/英文/日文1280宽及繁中786窄窗、深浅主题下逐一全选并打开更多菜单；各语言计数完整可见、底栏均45px、所有按钮/页码单行且无溢出、pageerror为空。首轮窄窗基线在入场缩放中采样导致高度比较失败；仅修正验证脚本，在截图等待动画完成后测量，没有更改生产代码或放宽0.5px容差，第二轮四语全通过。证据test-results/studio-footer-review/evidence.json；同目录zh-light-1280、ja-light-1280、zh-Hant-dark-786截图已亲自查看。

2026-09-11 18:11 +08:00 清理审计test-results/studio-footer-cleanup.json显示本轮Electron/Vite进程为空、7777无监听，测试隔离目录由finally回收。规格done/approval检查0 error/0 warning，范围/批次指纹不变；git diff --check通过。未提交或推送，未开始I2。项目视觉规范补充整行状态与固定底栏规则，并新增FK-PIT-0129，保留原批量控制器常驻约束。
