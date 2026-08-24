# FE-001：独立本地字幕工具页与单文件 SRT 纵向 UI

## 基本信息

- 日期：2026-08-03
- 状态：已完成
- 对应执行计划工作包：`FE-001`
- 目标环境：Electron renderer / preload固定`localSubtitleApi`合同
- 本轮未启动Vite dev server、Electron、official server、FFmpeg或其他前端服务

## 本次认领边界

本包把既有Job Manager、Production Executor、managed model、renderer session runtime和artifact reveal接成用户可见的最小单文件纵向切片。

当前production main只接受CPU、transcribe、no-VAD、SRT/LRC、可用conflict policy和export-only。本页面进一步收窄为单文件`CPU + transcribe + no-VAD + SRT + index + export-only`，没有提前展示以下能力：

- CUDA/Metal、VAD与translate-to-English。
- 模型下载、导入、删除或accelerator pack管理。
- 批量文件、音轨选择、LRC或多格式导出。
- 字幕预览/复制/重试、翻译handoff或自动启动翻译。

这些能力分别保留在`MODEL-002`、`FE-002`～`FE-004`与LINK工作包。

## 实现内容

- 新增独立`/tools/subtitle/local-transcriber` route、subtitle category工具卡、菜单映射与独立tone，不进入`AudioTranscriber`或任何`audio:*`合同。
- 新页面复用现有`ToolDetailLayout`、`ToolConfigPanel`、`ToolField`、`ToolFileDropZone`、`ToolRadioButtonGroup`和`ToolOutputPathPicker`。
- 页面进入时并行调用`probeRuntime()`和`listManagedResources()`，不触发模型加载；模型下拉只包含`resourceType=model && status=ready`条目。
- 输入文件通过`authorizeInputFiles()`签发opaque token；自定义输出通过`selectOutputDirectory()`签发opaque directory token。切换、离页或异步完成晚于离页时继续进入既有singleton cleanup retry queue。
- 纯`localSubtitleTranscriberModel.ts`集中完成runtime/session/model/file/output readiness与冻结请求生成，renderer始终提交production允许的CPU/no-VAD/SRT/index/export-only配置。
- 页面通过既有`useSyncExternalStore(getLocalSubtitleRuntimeService())`订阅共享revision状态，显示task stage/overall progress，支持task取消，并只用committed SRT的opaque`artifactRef`调用`revealArtifact()`。
- 完整runtime错误文本使用`min-w-0`、全宽边界和`overflow-wrap:anywhere`，避免长诊断撑破工具面板。
- 四语言补齐menu、tool card与页面全部静态/有限translation keys；源码usage checker可解析stage/status/readiness有限映射。

## 修改文件

- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/*`
- `src/App.tsx`
- `src/constants/router.ts`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/pages/Tools/index.tsx`
- `src/index.css`
- `src/locales/{zh,zh-Hant,en,ja}/{common,tools,subtitle}.json`
- 本主题Final Design、Execution Plan与v0.2.11入口台账

## 验证结果

执行：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run \
  src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts \
  src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberRegistration.test.ts \
  src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts \
  src/services/local-subtitle/localSubtitleRuntimeService.test.ts \
  src/store/tools/subtitle/useLocalSubtitleTranscriberStore.test.ts
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- TypeScript通过。
- 聚焦5 files / 28 tests全部通过，覆盖production request shape、readiness、committed artifact选择、route/meta/Audio隔离、固定preload bridge和既有session/store回归。
- 四语言locale parity通过，各1577 keys；源码usage检查1424 calls、1466 resolved keys，全部解析。
- 根Vite配置的renderer、Electron main与preload三段test build通过；只有既有dynamic-import与chunk-size warning。
- `git diff --check`通过。
- 未运行真实模型Electron产品E2E、窗口视觉矩阵或packaged目标机验证；这些未执行项没有记为通过，也不阻塞本包代码职责结项。

## 结项说明

`FE-001`已完成工具注册、route、i18n与单文件SRT纵向UI。M2的renderer代码路径已经存在，但真实FFmpeg + official server + PRE-006模型的Electron产品E2E仍需后续QA证据后才能声明packaged/目标机验收完成。

## 下一步

可推进`MODEL-002`模型/CUDA pack生命周期，或推进`BE-003`与`FE-002`的环境诊断、资源任务和模型管理UI。批量队列与音轨交互保留给`FE-003`。
