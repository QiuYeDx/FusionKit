# I5 第二轮十项体验完善收尾

| 字段 | 值 |
| --- | --- |
| 完成日期 | 2026-09-13（Asia/Shanghai，实施开始于2026-09-12） |
| 分支 | feat/subtitle-studio-transcription |
| 已先提交推送 | 3855c2c72bfa45740f248406f7266cf0342ae1f6，feat(subtitle-studio): complete subtitle formats and batch workflows；提交后核对远端OID一致 |
| 本轮版本 | 上述提交加未提交工作树；精确字节及证据摘要见2026-09-13-experience.snapshot.json |
| 范围指纹 | 0999033cd03225dc8ca9666f9f35a24ddab73770b9106bc5b3158a966720a89c |
| 环境 | Windows x64，Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3 |
| 状态 | 十项实现及所需技术验证完成；用户整体验收pending，本轮未自动提交；I4和打包仍后置 |

用户五图中的标注作为问题证据使用。先推送上一轮、再登记[原始问题](2026-09-12-experience-findings.md)及I5需求/设计/任务，随后按四组单写权完成。没有改变既有格式、来源保护和共享语音资源的范围。

## 十项结果

| 用户问题 | 完成行为 | 对应记录 |
| --- | --- | --- |
| 1 停止按钮反馈 | 独立浅深色危险操作hover/active，键盘焦点可见，与行背景可区分；原有禁用/取消能力保留 | experience-02 |
| 2 转写媒体拖入 | 高亮接收原生媒体File，与选择按钮共用授权/探测/草稿处理；多选、去重、部分失败和来源目录保留 | experience-01、02 |
| 3 可选自动翻译 | 默认关闭；启用后选择模型/目标语言，提交时快照；字幕成功发布后主进程交接一次，离页仍运行，失败保留文档并可恢复 | experience-02 |
| 4 参数持久化 | 保存转写模型/设备/语言/VAD/模式/高级参数和自动翻译偏好，重启恢复；旧/损坏数据回退，不保存文件能力、运行队列或密钥副本 | experience-02 |
| 5 环境状态布局 | 状态和重新检查紧凑同排对齐，长内容允许必要换行；检查/失败态继续可见 | experience-02 |
| 6 导出默认值 | 普通单份/批量默认双语、源文件所在目录、未完成使用原文；无轨允许明确回退，错误指定轨仍拒绝，同名防覆盖 | experience-04 |
| 7 导出表单与轨选择 | 唯一文档清单位于末尾、默认折叠；仅多轨出现选择框，检查结果也合并此处；相关字段按需成组，列表有滚动感知渐变 | experience-04 |
| 8 译文工具条 | 选择与清除相邻，状态和任务动作右侧分组；错误/恢复位于首行下方，空操作不占位 | experience-03 |
| 9 进度刷新闪烁 | 后台事件静默合并读取，前台操作优先；不触发整页忙碌或无关禁用，保留正文/焦点/滚动/页码/弹窗/提示，同revision正文不重复读取 | experience-03 |
| 10 文档列表统一 | 导出、翻译、总览、恢复、结果和确认清单复用文档行、列表和固定边缘渐变，名称省略、元数据、间距和操作对齐一致 | experience-04 |

分项R/AC/T/V映射见[媒体接线](2026-09-13-experience-01.md)、[转写与自动翻译](2026-09-13-experience-02.md)、[静默刷新](2026-09-13-experience-03.md)、[导出与文档列表](2026-09-13-experience-04.md)。

## 关键实现与修复依据

拖入仍使用固定内部IPC。preload在事件回调中同步从原生File捕获路径，renderer不能通过普通API传任意路径；主进程复核owner/frame、20项边界、真实普通文件和来源解析。媒体picker/drop共用授权流程，不确定的Windows临时代理不被猜作原始文件。后台队列只延迟处理已捕获的结果，不延迟读取File。

自动翻译意图与成功文档原子发布，稳定身份用于去重。密钥只在本次进程的受控交接中存在；重启遇到待交接意图会形成真实可恢复状态。重复完成、并发重放不会另建任务；清除任务或轨时同一事务写入撤销意图，避免重启复活。退出先阻止并等待交接，再释放翻译服务；普通ASR与媒体探测不等候自动翻译初始化。

闪烁来自进度事件读取使用了整个工具的前台忙碌通道。现在区分前台动作与静默对账，后台单飞并追读新变化，保留原来的修订、查询和卸载保护。显式操作不会因后台正在读取而被直接丢弃。

按项目UI及避坑技能审阅最终渲染，新增FK-PIT-0147和FK-PIT-0148，分别记录“后台读取与前台忙碌分离”和“排队前同步捕获原生拖入能力”。滚动渐变使用不拦截指针的固定兄弟层，同时观察视口及内容尺寸，避免遮罩随内容滚走。

## 实际验证

### 单元、集成与静态检查

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 相关回归 | 94文件、1648项通过；25文件31项有条件场景未在普通运行启用 | test-results/studio-i3-experience/related-regression.log |
| 最终受影响复验 | 13文件、248项通过：自动交接、task/sink/controller/preferences、翻译恢复、清轨、媒体IPC、导出与刷新协调 | test-results/studio-i3-experience/affected-final-unit.log |
| 生产和验收测试类型 | 两套生产TS及本轮测试严格TS全部退出0；测试类型在最后尺寸断言后再核对 | frontend-types-final.log、node-types-final.log、test-types-final.log（studio-i3-experience目录） |
| 四语与源码使用 | 每种语言459个Studio键，全部2318键；2144次调用/2167解析键均有定义；仅18项既有同源文字提示 | i18n-locales-final.log、i18n-usage-final.log |
| 真实依赖与来源 | 412个源码文件边界无错误；11项当前精确集成审计、5项旧工作树审计匹配；相关冻结/回放门禁包含在普通回归 | boundaries-final.json、integration-audit-final.json |
| 构建及preload | Vite renderer/main/preload构建成功，preload仅允许的electron外部模块；只有既有大chunk提示 | ui-build-verified.log、preload-final.log |
| 台账/差异 | spec done/overall通过，范围批准指纹未变；git diff --check通过 | spec-done.json、diff-check-final.log |

表中两批普通测试重叠，不能相加为独立用例总数。普通运行跳过的UI以如下显式环境变量单独执行；真实ASR/设备和打包类仍未在本轮重跑。

### 七套实际 Electron 场景

| 场景 | 实际结果 | 最终证据 |
| --- | --- | --- |
| 转写体验/自动交接 | 1/1，16.166s；原生File拖入、取消、默认关闭0次HTTP、启用后离页完成1次、重放/重启仍1次；设置保留，密钥不落盘，pageErrors为空 | test-results/studio-t06-ui/controlled-FCz3me/i5-transcription-result.json；test-results/studio-i5/transcription-ui-final.log |
| 静默刷新/工具条 | 1/1，12.344s；实际6个受控HTTP批次，进度busy/disabled变化均为空；无关正文读7→7；单击不丢、File同步捕获、页码/滚动/焦点/复制/弹窗/提示保留 | test-results/studio-i5-refresh/run-xenSzg/result.json；final-ui-aligned.log |
| 导出新体验 | 1/1，18.09s；零/单/多轨、8个真实来源目录输出、旧轨选择生效、原文件hash不变、11个弹窗无横溢出、计划前后清单唯一 | test-results/studio-i5-export/run-Zp8lci/result.json；test-results/studio-i5/export-ui-final.log中的该套通过项 |
| 既有文件/格式工作流 | 1/1，22.39s，原生字幕File、格式与来源/批量工作流通过 | test-results/studio-i3-files/run-0mQ0kP；export-ui-final.log中的该套通过项 |
| 既有文档库 | 1/1，80.86s；实际file加载，分页/跨页批量/选择上限/恢复取消/来源冲突通过 | test-results/studio-library；test-results/studio-i5/export-library-ui-final.log |
| 既有导出 | 1/1，53.54s；下载原始文件、源/译/双语、降级解释和冻结修订通过 | test-results/subtitle-studio-export；export-library-ui-final.log |
| 五尺寸布局 | 1/1，12.694s；正文高度420/304/140/492/660，外层溢出均0，标题间距12–16、底部间距6；分页/长列表/诊断展开和旧工具入口通过 | test-results/subtitle-studio-height；test-results/studio-i3-experience/layout-final.log |

最终转写hover在有限CSS过渡结束后归一为RGBA：浅色[227,0,7,36]，深色[255,99,99,36]，不是仅比较不同颜色字符串。转写运行环境中心差0，精确inner786×540时可见、无横溢出。译文工具条宽浅/窄深失败态均为选择→清除间距6px、选择/清除/右首行中心差0。所有这些最终截图已人工审阅。

布局测试原生setSize为1280×860、1106×756、786×540、786×900、1440×1100，本机无框窗口inner宽少1px，测量记录为1279/1105/785/785/1439。导出亦记录实际1279×860/785×540，未将原生窗口请求值冒充inner值；转写另有精确786×540断言。

导出四套最终UI使用renderer index-BptdzWdO.js/CSS index-CEFT13Dj.css。随后仅调整译文状态首行32px对齐；当前最终构建为index-DNsjFkub.js/CSS index-BmZJOtjV.css，静默刷新、转写和五尺寸布局在此构建复验，main/preload保持相同内容。转写测试单独编译明确受控原生运行时的主进程，其余IPC/preload、文档sink/repository、自动协调器、翻译服务/HTTP执行器均真实。没有为测试修改全局生产依赖。

### 执行方式与修复后复验

直接调用已安装的Node入口，无包管理器安装或打包：

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc --noEmit
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --tsBuildInfoFile test-results/studio-i3-experience/node.tsbuildinfo
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc --noEmit -p test-results/studio-i3-experience/tsconfig.tests.json
& 'C:/Program Files/nodejs/node.exe' node_modules/vite/bin/vite.js build --mode=test
& 'C:/Program Files/nodejs/node.exe' scripts/check-preload-bundle.mjs
& 'C:/Program Files/nodejs/node.exe' scripts/check-i18n.mjs
& 'C:/Program Files/nodejs/node.exe' scripts/check-i18n-usage.mjs
& 'C:/Program Files/nodejs/node.exe' scripts/subtitle-studio/check-boundaries.mjs
```

Vitest直接入口为node_modules/vitest/vitest.mjs，普通回归maxWorkers=2/minWorkers=1；UI为1/1串行运行。专项环境开关分别为FUSIONKIT_STUDIO_I5_TRANSCRIPTION_UI、FUSIONKIT_STUDIO_I5_REFRESH_UI、FUSIONKIT_STUDIO_I5_EXPORT_UI、FUSIONKIT_STUDIO_I3_UI；既有导出和布局使用FUSIONKIT_STUDIO_E2E，文档库使用FUSIONKIT_STUDIO_PACKAGED_UI。具体条件以各测试入口为准。

初次UI中的测试选择器/旧导出菜单假设及library开发服务条件已迁移到真实现有界面和隔离file模式，未放宽业务断言。export-ui-final.log整体仍保留当时1失败/2通过/1跳过，失败的旧export及跳过的library均由export-library-ui-final.log的2/2通过补齐。不要把前一日志整体写成通过。

工具条初次窄错误态审阅发现左侧按整体高度居中；修正首行布局后实际断言仍发现2px误差，最终对齐到相同32px首行并复验0px，没有放宽断言。转写hover初次JSON记录落在颜色过渡起点，已加有限动画完成等待与RGBA颜色/透明度实质断言；随后发现小窗实际799宽，又将fixture改成精确inner786×540并重跑同套。早期日志和截图保留为修复过程，不作为最终通过证据。

一次普通沙箱PowerShell启动i18n命令因StandardOutputEncoding启动异常未执行；以同一只读Node检查在允许的执行环境重跑成功。没有把该启动错误当作检查通过，没有安装新依赖。

## 清理、限制与接续

最终独占进程检查为0，见test-results/studio-i3-experience/process-cleanup.json；各新UI的cleanup JSON记录Electron、受控服务、隔离app/profile均已释放。测试仅使用合成文件及隔离配置，源文件hash保护通过；未结束用户自己的应用或服务。

本轮覆盖真实OS文件形成的File及生产桥接，不宣称完成物理资源管理器长路径拖拽手势验收。受控ASR和本机HTTP用于确定性交接/界面测试，不替代真实ASR效果、真实供应商质量、GPU或macOS矩阵。本轮没有进行打包演练、签名、公证或发布。已有共享资源实现和原生生产基线继续保留。

十项范围没有遗留实施子项。用户可直接在当前工作树启动应用验收；I5批次状态为verifying、acceptance为pending。上一轮3855c2c已先推送，本轮改动等待后续提交指令。I4编辑及打包继续按用户既有优先级后置。
