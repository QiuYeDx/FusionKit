# 字幕工作台：源文件元数据变化导致路径授权误失效

## 问题与证据

用户在 Windows 报告：队列中的媒体经外部播放器打开后，转写及原目录导出表现为源文件不可用。

源文件比较函数原先仅在 Darwin 忽略 ctime，在 Windows 把 ctime 变化判为 media_changed。真实 Windows 临时文件实验确认，读取文件并改变/恢复文件属性后，文件 ID、大小、mtime 完全相同而 ctime 改变。授权校验失败还会移除 capability，因此后续操作可能转为授权失效。

此外，媒体预处理在音轨探测前后、探测结果绑定及源文件复制结束时使用了私有文件的严格比较规则。只修入口函数仍会留下失败路径。

## 修复范围

- 用户源文件统一比较精确文件对象身份、大小和 mtime。ctime/atime 不作为源文件内容或路径失效依据。
- 文件授权、任务续期和原目录绑定已有共用比较函数，因此现存持久化源路径记录自动适用修复，不需要改写记录或重新绑定目录。
- 音轨探测显式区分用户输入与私有快照；音轨绑定、源文件复制完成检查及批量去重使用用户源文件规则。
- 私有快照、PCM、模型和运行时资源继续严格检查。原路径、符号链接和父目录对象身份检查保留。文件移动、替换及大小/mtime 变化继续失败。
- 不根据显示名称寻找文件，不自动接受新文件或新父目录对象。此前已被删除的会话 capability 不会凭路径字符串重新授权。

## 验证

新增测试使用真实文件属性变化，断言文件 ID、大小、mtime 不变且 ctime 确实变化；覆盖草稿探测前后、音轨绑定、复制期间、排队等待、任务续期、转写文档发布、持久化重开及导出计划生成之后。反例包括真实内容编辑、同名替换、移动、父目录替换、私有快照元数据变化，以及跨 ctime 更新重新授权造成的重复入队。

将三个生产文件临时恢复为 HEAD 旧实现后，新测试集出现 7 项预期失败；恢复修复后再验证。旧实现失败日志保存在本地 `test-results/source-metadata/before-fix.log`。

检查命令：

```text
node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription test/subtitle-studio/transcription-task-service.test.ts test/subtitle-studio/acceptance-source-output.test.ts test/subtitle-studio/export-service.test.ts test/subtitle-studio/export-planner.test.ts test/subtitle-studio/export-translation.test.ts --maxWorkers=2 --minWorkers=1
node node_modules/typescript/bin/tsc --noEmit --pretty false
node scripts/subtitle-studio/check-boundaries.mjs
git diff --check
```

相关回归首轮 963 项通过、4 项 Electron 专用测试按配置跳过；新增重复文件回归后，最终定向套件 74 项全部通过，共验证 964 个不同用例。TypeScript 及 509 个文件的真实依赖边界检查通过。本次没有启动 Electron、真实播放器或模型推理；媒体进程使用固定响应，文件读写、授权、持久化和导出使用真实实现。尚未在 macOS 真机复测。

## 维护边界

这是当前 Studio 分支的行为修复，有意修正了历史拷贝中的源文件比较语义。旧 local-subtitle 实现及历史迁移 baseline、copy recipe、provenance 文件保持原样。独立的 `current-copy-audits.json` 仅记录此次两个修复文件，绑定历史目标 SHA-256 和当前审阅 SHA-256；拷贝检查与配对回放共同校验该记录。未知文件、重复记录、基线偏移、审阅后再次修改、移除审计或未经记录的回退均不会被静默接受。未全局放宽资源、模型或私有文件的身份校验。

文件大小和 mtime 是内容变化的实用检测信号，不是内容哈希。针对同一对象恶意改写等长内容并恢复 mtime 的防护不在此修复的保证范围内。

迁移维护校验另外验证了 47 项既有 copy 工具测试和 10 项当前审计测试，均通过。全仓历史 `copy --check` / 配对回放受既有基线偏移阻塞：旧 `job-manager`、`production-executor`、页面、post-action service、domain/IPC 及对应测试共 11 个源文件已不同于冻结基线；当前 Studio 的 `productionExecutor.test.ts` 也已有目标副本差异。这些文件没有在本次修改。未扩大审计白名单以绕过它们，历史基线问题仍需单独整理。
