# 工作包 LINK-006：Artifact ref 与 one-shot import token

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：`LINK-006`
- 目标平台/硬件：Electron main 跨平台合同；不依赖 Windows 专用开发环境或真实 native runtime

## 本次认领边界

- 包含：artifact ref同会话安全轮换、validated内容快照、owner-bound短TTL one-shot import token、main-private consume、task/owner/TTL/consume清理与production composition。
- 不包含：字幕翻译Store读取、配置快照、taskId/handoffKey/target handle、translation task入队或自动启动；这些属于`LINK-007`/`LINK-008`。

## 本次实现内容

- Artifact Registry新增`expired`与`rotated`私有状态；有效ref直接复用，过期ref只有在重新验证directory/file identity、size、SHA、UTF-8、格式与cue后才签发新ref，并合并并发refresh。
- 旧ref在read/reveal/handoff公开操作中保持`artifact_expired`；task revoke、generation替换和owner release会清理旧ref、轮换别名及新ref，之后不能从snapshot补发。
- Session IPC在读取completed snapshot前只刷新已过期且可复核的artifact ref，通过正常revisioned `task-updated`同时替换`task.artifactResults`与`task.completion.artifacts`；单项变化或失效不使整个session snapshot失败。
- 新增`LocalSubtitleArtifactHandoffService`。它将已验证字幕复制进main内Buffer，签发owner-bound、短TTL、one-shot token；公开`handoffArtifact`只返回`translationImportToken + expiresAt`。
- main-private consume只返回字幕内容、格式、展示名、cue数及path-free artifact identity；文件在token签发后变化不影响已冻结快照，消费阶段不再读取路径。
- handoff service跟踪token所属owner/task。result clear/task remove先撤销该task的未消费token并清零Buffer，再撤销artifact ref；owner end、TTL、消费成功/失败也通过registry dispose统一清零并阻止重放。
- Production main提前创建typed import-token registry与handoff service，JobManager、IPC和Session bridge显式共享同一组实例。

## 修改文件

- `electron/main/local-subtitle/subtitle-artifact-registry.ts`
- `electron/main/local-subtitle/artifact-handoff.ts`
- `electron/main/local-subtitle/session-ipc.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `test/local-subtitle/subtitleArtifactRegistry.test.ts`
- `test/local-subtitle/sessionIpc.test.ts`
- `test/local-subtitle/ipc.test.ts`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- `LocalSubtitleArtifactHandoffSnapshot`新增main-private `taskId`与`generation`，用于构造path-free artifact identity。
- `LocalSubtitleArtifactRegistry`新增`refreshSummary(owner, summary)`；renderer没有refresh-by-path或任意refresh IPC。
- `LocalSubtitleArtifactHandoffService`提供`handoff()`、`consume()`、`revokeTask()`与artifact summary refresh组合能力。
- public IPC请求/响应schema与preload channel未扩张：既有`handoffArtifact({ artifactRef })`现在返回真实token/expiry。

## 安全、隐私与许可证检查

- renderer不接收真实path、SHA、字幕内容、taskId/generation identity或main-private snapshot；公开响应测试显式扫描path/content/hash。
- token与artifact ref registry分离，分别保持owner、operation、TTL与one-shot语义；artifact ref不能冒充import token。
- 字幕内容只在main内存Buffer中短暂存在，所有dispose路径清零；未新增持久化、日志字段、依赖、native artifact或许可证变化。
- 本包遵循`FK-PIT-0021`，只通过typed artifact handoff连接本地转写与字幕翻译，不进入remote Audio ASR路线；遵循`FK-PIT-0022`，没有用renderer raw path适配旧字幕任务字段。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle/subtitleArtifactRegistry.test.ts test/local-subtitle/ipc.test.ts test/local-subtitle/sessionIpc.test.ts test/local-subtitle/authorizations.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：TypeScript；6 focused test files / 76 tests；完整local-subtitle 53 passed + 2 skipped files / 1062 passed + 2 skipped tests；renderer/main/preload三段Vite test build；diff check。
- 覆盖：有效ref复用、过期ref并发安全轮换、changed artifact拒绝、session revision更新、公开响应无path/content/hash、快照不重读文件、消费/重放、task撤销token与artifact、Buffer清零。
- Vite仅报告仓库既有dynamic-import与chunk-size warning；2个skip均为未启用的真实native server测试。
- 未启动Vite/Electron前端服务；未执行`pnpm`，未修改`pnpm-lock.yaml`。
- 未运行真实Electron/window-destroy人工矩阵；owner-release合同由registry与IPC回归覆盖，本包不以人工QA阻塞代码结项。

## 未完成事项与风险

- token目前只有main-private consume primitive，没有translator-owned配置快照或candidate factory消费者；这是有意的包边界。
- 已进入consume callback的token已完成one-shot领取，task清理只保证撤销尚未消费token；后续`LINK-007`必须让consume与candidate构造处于固定协调器的失败清理边界内。
- 跨重启不恢复artifact/token authority；用户只能从当前main session的有效completed task发起handoff。

## 下一步建议

- 实施`LINK-007`：由字幕翻译模块拥有配置readiness与安全快照，使用本包main-private consume生成绑定taskId/handoffKey/target handle的候选，并按receipt精确start。
- 保持`importArtifact`的auto-start模式只来自已冻结snapshot，不允许调用方临时传入；不要调用`startAllTasks()`。
