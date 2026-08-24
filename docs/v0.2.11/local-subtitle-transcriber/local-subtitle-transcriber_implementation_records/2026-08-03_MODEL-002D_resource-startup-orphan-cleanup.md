# 工作包 MODEL-002D：Resource startup orphan cleanup

## 基本信息

- 日期：2026-08-03
- 状态：已完成（顶层`MODEL-002`继续进行中）
- 对应执行计划工作包：`MODEL-002`
- 目标平台/硬件：macOS arm64与Windows x64共享代码合同；未执行真实公网大文件下载或目标机native smoke

## 本次认领边界

- 包含：model/VAD/accelerator受控下载与staging root的启动扫描、合法续传保留、无效download state与metadata temporary清理、production staging orphan隔离删除、ModelManager启动门禁和production main接线。
- 不包含：`BE-003`的task/media/server session历史orphan、用户输出目录扫描、会话摘要、真实模型/VAD/CUDA下载、FE-002、packaged或目标机产品验收。

## 本次实现内容

- 新增`resource-startup-cleaner.ts`，集中冻结共享`downloads`、model/VAD staging及Windows accelerator downloads/staging布局；三个manager复用同一目录常量，避免扫描合同与生产写入命名漂移。
- 下载器提炼`reconcileLocalSubtitleResourceDownloadState()`：只有source/effective URL、allowlist、expected size、bytesCompleted、part size、metadata schema和ETag/Last-Modified全部匹配时保留跨重启续传；单边、空文件、oversize、invalid JSON、manifest drift或无validator状态按稳定对象身份清理。
- partial ownership proof只使用dev/ino/birthtime，size仍作为独立内容合同；清理前重验regular file、非symlink、single-link和对象身份，所有已认领叶名all-settled并保留首个失败。
- 清理exact `${resourceId}.part.json.tmp-${UUID}`写入临时文件；当前catalog未知的`.part`、metadata或其他下载叶名保持不动。
- staging只识别production真实生成的`.import-*`、`.install-*`、`.cleanup-*`、`.delete-*`、`.superseded-*`及本cleaner的`.startup-cleanup-*`完整格式；unknown名称不处理，exact-name symlink或非目录使启动门禁fail closed。
- staging候选先rename到同一private root的唯一startup quarantine，rename后比较dev/ino/birthtime并独立复核realpath containment，再递归删除；Windows删除固定`maxRetries=5`和`retryDelay=200`。
- `LocalSubtitleModelManager.initialize()`缓存同一Promise；初始化pending时资源API返回`resource_busy`，失败后锁存为`resource_not_allowed`。shutdown会等待已启动的初始化operation。
- production main在注册local-subtitle IPC和创建窗口前等待初始化；cleanup失败被manager锁存，不让root身份不可信的资源操作继续，同时不阻断FusionKit其他功能启动。

## 修改文件

- `electron/main/local-subtitle/resource-startup-cleaner.ts`
- `electron/main/local-subtitle/resource-download.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `electron/main/local-subtitle/vad-manager.ts`
- `electron/main/local-subtitle/accelerator-manager.ts`
- `electron/main/index.ts`
- `test/local-subtitle/resourceStartupCleaner.test.ts`
- `test/local-subtitle/modelManager.test.ts`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- main-only下载模块新增`ReconcileLocalSubtitleResourceDownloadStateOptions`、`LocalSubtitleResourceDownloadStateResult`、`LocalSubtitleResourceDownloadMetadata`与`reconcileLocalSubtitleResourceDownloadState()`。
- `LocalSubtitleModelManager`新增显式、幂等的`initialize(): Promise<void>`及仅供测试/组合根使用的`startupCleanup`注入点；未新增renderer IPC channel、public request字段或持久化状态。
- 三类manager目录policy现在引用统一startup cleanup layout，生产下载目标和扫描root保持同源。

## 安全、隐私与职责检查

- 只扫描`<userData>/local-subtitle`下的固定app-private child roots；不读取或持久化用户输出路径，不扫描任意manifest path，也不接管`BE-003`的task/media/server temp。
- unknown path默认忽略；exact-name symlink、hard-link、root replacement、quarantine replacement和containment drift均不删除未知对象。
- 下载metadata只用于main内部续传判定，不进入renderer、Store、日志或实施文档；初始化错误对renderer只暴露稳定错误码和固定文案。
- 未新增依赖、未执行pnpm、未修改`pnpm-lock.yaml`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/resourceStartupCleaner.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/vadManager.test.ts test/local-subtitle/acceleratorManager.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

结果：

- 聚焦5 files / 73 tests全部通过，覆盖合法resume保留、单边/mismatch/no-validator/tmp清理、model/VAD/accelerator完整staging模式、unknown忽略、symlink fail closed、quarantine identity replacement、all-settled与manager initialize Promise/failure locking。
- local-subtitle 49 passed + 2 skipped files / 1016 passed + 2 skipped tests；2个skip仍是默认未启用的真实native server测试。
- TypeScript与`git diff --check`通过。
- 未运行真实1.08 GB模型、885 KB VAD或678 MB CUDA archive下载，未运行packaged/目标机native smoke；这些不是本代码checkpoint的已完成证据。
- 未启动Vite dev server、Electron、official server或其他长期服务。

## 未完成事项与风险

- 顶层`MODEL-002`仍缺真实大文件Range/断网/恢复、VAD native load及Windows CUDA archive/install/GPU目标机证据，因此保持`进行中`。
- 启动cleaner只认当前冻结catalog和production完整命名；未知旧版本叶名不会被猜测删除。未来若资源命名升级，必须显式增加versioned migration/ownership合同。
- `MODEL-002D`不处理活动进程资源；production main在manager/job创建后、IPC和window前调用，后续若改变启动时序必须保持“无活动resource job”前置条件。

## 下一步建议

- 进入`FE-002`资源管理UI，复用现有managed-resource list/install/delete、ResourceJob snapshot/event与稳定错误码，不新增renderer URL/path authority。
- 真实模型/VAD/CUDA下载和目标机smoke按`MODEL-002`/QA边界单独记录，不用它们阻塞FE代码纵向切片。
