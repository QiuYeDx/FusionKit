# I9 启动遮罩：隐藏重载与就绪生命周期

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-14 |
| 任务 | T-RELEASE-02 |
| 验证版本 | dec9010 + 2026-09-14-release.snapshot.json（SHA-256 38bd3dfec11f3b2bdd5bb3827cc4ea6461b12c6c7a80a691bb1edb0776d01849）；原生实物/实际app另以各自回执及报告绑定 |
| 环境 | macOS arm64，Node 20.19.5、Electron 41.10.6、Vitest 2.1.9、Playwright 1.58.2 |
| 任务指纹 | 0c1d1d0d4bd889b94ccecf994aa8a335c19fa09f441546e9aaa586d9542a21d2 |

## 实际结果

历史 `2026-09-13-result-density.md` 记录的 Windows 主题/语言重载超时没有完整原始运行产物随 Git 带到本机。基线原 I7 套件在当前 macOS 一次通过（28.56 秒，`test-results/studio-i7-results/run-xjQ4RQ/`），因此没有宣称原 Windows 故障在本机原样重现，也没有把主题或语言配置本身认定为根因。

本轮在真实生产 main/preload/renderer 上固定复现了同一启动链的活性缺口：原生窗口隐藏后重载，再次显示时工作台 DOM 已生成，但加载层仍停在 0%。基线 `test-results/preload-loading/run-65t2ki/failure.json` 保留失败与清理；后续 `run-Utv7tC/failure.json` 进一步记录原生 `isVisible=true`、`isFocused=true`、hide=1、show=0、focus=1，renderer 可见且动画帧已推进 228 帧，开始信号仍为 0。故障并非动画帧不运行；在本机 Electron/macOS 的快速隐藏、重载、显示序列中，原生 show 通知可能没有发出。

此前 main 只在首次 `ready-to-show` 或可见窗口的 `dom-ready` 发送进度开始信号。隐藏重载错过后，preload 的完成请求仍等待 `minimumCountCompleted`，原来的 4999ms 兜底也仅请求完成，不能解除缺少开始信号的等待。

测试诊断中的另一个边界是 `document.visibilityState`：Playwright 附加调试器时，即使原生窗口隐藏，DOM 仍可能报告 visible。最终测试以原生 `isVisible()` 确认隐藏状态，并被动记录原生事件；不以 DOM visibility 代替窗口事实。尝试在 inspector evaluation 内等待原生 show 的运行超时，保留为 `run-ABoIsA` 的 harness 失败，其 profile 和进程随后已清理，不计为通过。

## 实现

- main 保留 show 直接发信号，并在 `dom-ready` 遇到隐藏窗口时每 50ms 核对一次原生可见性，最多持续 5 秒。成功开始、主 frame 新导航/重载和窗口关闭均清理定时器。可见窗口立即发信号，不建立持续轮询。
- preload 仅在收到既有 renderer `removeLoading` 就绪通知后启动一次独立的 4999ms 清理期限。这个清理不再依赖进度开始、可见性或动画帧；没有就绪通知时不会自动揭幕。
- 清理状态独立标记 disposed，重复清理与迟到的挂载、完成回调不重新创建遮罩；取消动画、定时器、帧请求、IPC/visibility/resize 监听，并移除遮罩和样式。
- 没有修改现有动画视觉、正常阶段时长、src 启动通知或工具业务；没有新增公共 IPC。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RELEASE-02-1 | 通过 | inline: 专用实际 Electron 41.09 秒，原 I7 完整结果流程 28.04 秒；见下面两个最终运行目录 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RELEASE-02-1 | 通过 | V-RELEASE-02-1 |

以上为技术验收标准；用户整体验收由 spec 独立记录。

最终专用用例 `test/preload-loading-ui.test.ts`，产物 `test-results/preload-loading/run-TxzOBj/`，日志 `test-results/preload-loading-final.log`：

- 隐藏重载后原生 show 事件仍为 0，但已收到一个真正的开始信号，2 秒正常起步断言通过，随后完成动画和移除遮罩，证明原生可见性补偿实际生效。
- 仅丢弃一次内部开始通知，生产 renderer/main/preload 保持真实；从 reload 起约 5156ms 后遮罩和样式均移除。
- 内部开始通知延迟 800ms，初始保持 0%，随后正常起步与退出。
- 中文浅/深、英文深/浅四次连续 reload 均通过，正常退出约 3746–3768ms；实际 html 主题和最终可见工作台均有断言。
- 扣留真正的 renderer 就绪通知超过 5.2 秒，仍保留 92% 遮罩；放行后正常退出，防止无条件超时提前揭幕。
- 页面错误为空，截图确认英文深色工作台已经显示，以及慢就绪时 92% 遮罩仍在；cleanup 确认 Electron 关闭和隔离 profile 删除。

原 I7 完整用例 `test/subtitle-studio/result-feedback-ui.test.ts`，最终产物 `test-results/studio-i7-results/run-8GemQ8/`，日志 `test-results/preload-loading-final-i7.log`：

- 27 条动作/状态记录、12 组结果几何、3 次本机受控 HTTP 请求，导出、原文件保存、部分/全部失败导入、取消、翻译提交、删除与批量导入全流程通过；源文件 hash 不变，pageErrors 为空。
- 完整保留原来的起步、几何、关闭内容和业务断言，没有扩大超时或删除断言。
- 人工看图发现原 harness 在切到浅色看板后，后续文件名仍标记 dark。现将实际浅色的删除/批量导入截图正确命名；英文重载显式设为深色并校验 html class；每份结果几何都记录实际主题并和截图名匹配。修正后全套重跑通过，最终英文窄深错误详情截图已审阅。
- cleanup 确认 Electron、受控 HTTP 服务关闭及隔离 profile 删除。`run-wKp3Uk` 保留为修正截图主题前的一次完整功能通过，不冒充其英文截图为深色。

生产源码及上述两个测试文件的严格 TypeScript 检查通过，日志 `test-results/preload-loading-types.log`、配置 `test-results/preload-loading-tsconfig.json`。root 最终统一 TypeScript/三端 Vite/preload bundle 构建通过，日志 `/tmp/fusionkit-i9-final-build.log`；`git diff --check` 通过。

两个最终 Electron 运行使用相同构建：

| 产物 | SHA-256 |
| --- | --- |
| main | db6182310edcc2c34c38163d19948dffb170c1c4a38ac7e4bb3b6f209f1d8f72 |
| preload | baf2fe7b927018b9ee7e888415d98a6338aba61eb495dd6865e3fbf10d52ad40 |

## 风险与未执行项

本轮没有启动 Vite dev。所有本子任务的 Electron、模拟 HTTP 服务和 profile 均已清理，最终独立进程核对未发现 `test-results/preload-loading/` 或 `test-results/studio-i7-results/` 所属进程，证据为 `test-results/preload-loading/final-process-audit.json`。失败记录不删除、不计入成功。

本记录证明当前 macOS 开发构建的启动与结果流程。未单独重跑 Windows，也不代表签名安装包、真实 ASR、真实供应商或用户整体验收通过；这些由其他 I9 任务分别提供证据。新增项目经验 FK-PIT-0154 说明原生可见性、通知和 renderer 就绪之间的边界。
