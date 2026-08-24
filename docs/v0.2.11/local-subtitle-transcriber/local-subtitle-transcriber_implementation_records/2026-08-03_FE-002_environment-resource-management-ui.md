# 工作包 FE-002：环境与 managed resource 管理 UI checkpoint

## 基本信息

- 日期：2026-08-03
- 状态：进行中
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：macOS arm64与Windows x64共享renderer；本轮未执行真实模型/VAD/CUDA下载、Electron产品E2E或目标GPU验证

## 本次认领边界

- 包含：runtime/server/FFmpeg/platform/arch/backend摘要，model/VAD/accelerator清单，下载、GGML文件导入、取消、删除、占用、ResourceJob进度/失败/retry与SPA snapshot/event重同步UI。
- 不包含：main侧`devicePreference=auto`解析、GPU production admission、GPU失败后的用户确认CPU新generation、VAD任务配置、批量任务、字幕结果预览或真实大文件/目标机QA。

## 本次实现内容

- 新增`LocalSubtitleEnvironmentManager`，用现有`ToolPanel`、`Button`、`Badge`、`Progress`、`Dialog`和`ToolRadioButtonGroup`组成紧凑的环境与资源工作区，没有复制近似共享工具页控件。
- 环境摘要由`probeRuntime()`真实结果驱动，展示probe已接受的server HTTP contract、runner version、FFmpeg version、platform/arch，以及CPU/CUDA/Metal各自的`available/unavailable/unverified/not reported`状态；runner/media/backend失败只显示稳定error code。
- 当前production admission只接受CPU/no-VAD，因此开始前明确显示CPU task profile；任务提交后显示main返回的真实`resolvedBackend`，不把Metal/CUDA probe可见性伪装成GPU已执行，也不做renderer侧silent fallback。
- managed resource列表只消费`listManagedResources()`返回的`resourceId`、类型、状态、version、byteSize与兼容backend；install/delete请求只回传该受控`resourceId`，renderer未新增URL、下载路径、模型路径或hash输入。
- 下载与导入经用户显式操作发起。模型导入只接受Electron选择的文件对象，支持copy/move并在确认框展示预计新增占用；文案明确为与内置manifest匹配的GGML文件，不声称支持不存在的任意自定义模型或CTranslate2目录。
- resource进度只读取共享`LocalSubtitleRuntimeService.resourceJobs`。页面不从`startResourceInstall()`/`importModel()` Promise保存任务阶段；action成功只触发既有runtime snapshot refresh，ResourceJob终态再重读managed manifest，离页返回继续使用既有subscribe-before-snapshot/revision reconciliation。
- 每个resource按最新`updatedAt/createdAt`关联ResourceJob，活动阶段显示progress和bytes，可取消；failed job保留稳定错误并立即提供重试/清理操作。ready资源占用单独汇总，not-installed资源只显示manifest size。
- 抽取`LocalSubtitleErrorNotice`，error message/code、resource display name和导入文件名全部使用`min-w-0`、`break-words`、`whitespace-pre-wrap`与`overflow-wrap:anywhere`的block surface，避免长诊断撑开页面或ScrollArea。
- 四语言补齐环境、backend、resource类型/状态/job阶段、import与delete确认文案；页面打开时只执行probe/list/session snapshot，不自动下载资源，也不启动带模型server。

## 修改文件

- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleEnvironmentManager.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleErrorNotice.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts`
- `src/locales/{en,ja,zh,zh-Hant}/subtitle.json`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- 未新增或修改preload/main IPC channel、request schema、ResourceJob状态机或持久化Store字段。
- 页面新增短生命周期的按钮request pending集合，只用于阻止重复点击；下载/校验/commit/cancel/failed真值仍完全来自revisioned session snapshot/event。
- 页面model新增最新ResourceJob选择、活动状态判断、ready资源占用与byte格式化纯函数。

## 安全、隐私与职责检查

- 下载请求只能提交来自main清单的opaque `resourceId`；导入只能提交Electron file picker产生的`File`与固定copy/move枚举。
- UI不接收或显示source URL、managed absolute path、download path、model hash、token/capability或命令行。
- move导入的源文件删除仍由main在verified commit后执行；renderer不做文件系统操作。
- 打开页面不会触发resource install/import/delete或模型server启动；只调用read-only runtime/resource/session probe。
- 未新增依赖、未执行pnpm、未修改`pnpm-lock.yaml`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber src/services/local-subtitle/localSubtitleRuntimeService.test.ts src/services/local-subtitle/localSubtitleSessionReducer.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
git diff --check
```

结果：

- 聚焦renderer/runtime 5 files / 32 tests全部通过，覆盖受控API source wiring、ResourceJob latest/active/terminal视图、ready占用、session reducer与subscribe-before-snapshot runtime reconciliation。
- TypeScript与renderer/main/preload三段Vite test build通过；仅保留既有dynamic/static import和chunk size warning。
- 四语言各1632 keys完整，source usage全部解析；既有9条same-as-source提示无新增错误。
- `git diff --check`通过。
- 未启动Vite dev server、Electron、official server或其他长期服务；未执行视觉QA、真实大文件下载或目标GPU验证。

## 未完成事项与风险

- Job Manager/Production Executor当前仍拒绝非CPU或`devicePreference=auto`请求；UI不能在renderer侧替main做可信backend resolution。因此auto选择、显式GPU失败和用户确认CPU新generation仍是`FE-002`未完成边界。
- 当前导入合同只认冻结manifest对应的首发GGML模型文件，不支持任意模型ID或CTranslate2目录；UI已按真实合同收口，未来扩展必须先新增main manifest/schema与验证合同。
- 真实1.08 GB model、885 KB VAD、678 MB CUDA archive下载、断网续传、packaged Electron与目标GPU仍由`MODEL-002`/QA包提供证据，不用代码级FE checkpoint冒充。

## 下一步建议

- 先在main建立可信的`auto -> resolvedBackend`批次commit合同并让Job Manager/Executor接受已验证GPU profile；renderer只展示main结果，不自行推断。
- GPU generation失败后新增显式CPU重试CTA，新请求必须生成新的batch/generation，旧失败任务不得被改写为CPU成功。
- 上述边界闭合后把`FE-002`标记完成，再进入`FE-003`的多文件授权、音轨选择与批量队列。
