# T-WORKSPACE-06 既有检查失败修复

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-06 |
| 日期 | 2026-09-10 |
| 验证版本 | 基线 27cdca32d7bc24712dad4e44e541bd5b9c42c07e 加本次修复；非文档源码摘要 5b1cd0e11cf8b2838e478a131195d09453a9943a77fc8e47046f0334cfba09ce |
| 环境 | macOS arm64；既有 pnpm 8.7.0 node_modules；TypeScript 5.9.3、Vitest 2.1.9、Vite 5.4.21；未安装依赖或改变 pnpm-lock |
| 任务指纹 | a53755a48a614e5cea5d1205868372626d6e62d07cf01fc0a6ab2ce83d376906 |

## 实际结果

用户明确限定本轮仅修复三个既有检查问题：默认 TypeScript 的 smooth-corners/observer 解析、NameTranslator 的 i18n 动态 key/清单、旧字幕的五项路径断言；复杂且影响面大的旧问题可后置，完成后提交推送，不继续其他工作。授权来源登记于 spec.json A-05。三项均可通过局部修复解决，没有遗留这三项中的问题。

TypeScript 的 Node（Node10）解析模式不读取依赖的 exports 类型映射，而 smooth-corners 0.1.0 已在 ./observer 的 types 条件提供真实声明。主配置改用适合 Vite 的 Bundler。单独核对引用的 tsconfig.node.json 时还发现相同原因导致 rollup/parseAst 与 @tailwindcss/vite 解析失败，因此同步该配置；仅改两行解析选项，保持 module、strict、noEmit 及 Vite 输出格式。未增加 any 声明、复制第三方类型、访问包私有路径或升级依赖。编译器解析确认 observer 指向 types/observer.d.ts；内存中将 radius 换成字符串会报 TS2322，类型约束仍生效。

NameTranslator 已将遍历各 scope 的 hint 改成查找所选 scope 并回退首项，但清单仍匹配旧 scope.hintKey，造成一项 DYNAMIC_KEY 与一项 STALE_MANIFEST。只更新 manifest 的精确表达式选择器，仍限定 self/children/descendants 三个已有 key。未修改界面、词条或 checker，也未使用通配符、忽略项或运行时 fallback 绕过检查。

旧字幕在 8950e15（2026-09-06，任务详情改进）已按用户要求引入 sourcePathDisplay/outputPathDisplay，类型注释、严格 DTO、生产者和 phase12 的 T-SEG-06C 记录一致：这两个字段允许显示完整路径，但不授予文件读写权限。五个旧断言将整个结果序列化后禁止出现目录路径，已经与该契约不符。仅修正三个测试文件：逐条核对显示字段等于实际 canonical 路径，只从声明过的 task/artifact 位置去掉该字段，继续对其余完整状态禁止内部路径、模型/VAD 路径、token、reservation 与文件身份字段泄漏。用于校验的 DTO schema 均为 strict，未知字段不能先被剥掉再假装通过。路径匹配按 JSON 转义比较，避免 Windows 反斜杠造成漏检。

同时在生产 IPC/registry 验证显示路径不能替代 fileToken 或 artifactRef，伪造显示字段的请求被拒绝，错误不回显路径/token，既有任务状态不变，有效 artifactRef 仍可正常读取。没有修改旧工具的生产实现、授权逻辑或用户可见行为。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 默认 TypeScript | 通过 | inline: 修复前仅 observer TS2307；修复后 node_modules/.bin/tsc --noEmit exit 0 |
| Vite 配置 TypeScript | 通过 | inline: 单独 tsconfig.node.json 检查 exit 0，tsBuildInfoFile 定向临时副本；Node 模式原有两个 TS2307 在 Bundler 下消失 |
| i18n 完整性/用法 | 通过 | inline: check-i18n exit 0，保留原有 18 条同值提示；check-i18n-usage exit 0，1880 calls、31 manifest、1892 resolved keys |
| i18n checker 回归 | 通过 | inline: node --test scripts/check-i18n-usage.test.mjs，7/7 通过；既有 stale/wildcard/missing-key 负例仍生效 |
| 旧字幕五项失败及相邻权限契约 | 通过 | inline: 最终 8 文件 282/282，通过全部原五项失败、strict DTO、owner/capability、session/artifact 权限及新增显示路径授权反例，0 跳过/失败，2.41s |
| V-WORKSPACE-06-4 | 通过 | inline: 两份配置的类型检查、隔离根 Vite renderer/main/preload 全新构建、preload allowlist、四语言完整性/源码引用、git diff --check 与 ready/spec 检查通过 |

```sh
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.node.json --tsBuildInfoFile /private/tmp/fusionkit-check-fixes-smbqbpdb/node-types.tsbuildinfo
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node --test scripts/check-i18n-usage.test.mjs
node_modules/.bin/vitest run test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/subtitleExporter.test.ts src/type/localSubtitleIpc.test.ts test/local-subtitle/authorizations.test.ts test/local-subtitle/ipcSecurity.test.ts test/local-subtitle/subtitleArtifactRegistry.test.ts test/local-subtitle/sessionRegistry.test.ts --maxWorkers=1 --minWorkers=1
# 仅在隔离源码副本执行，避免根配置清理用户 dist-electron
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
```

最终构建使用 /private/tmp/fusionkit-check-fixes-smbqbpdb，读取同一份既有 node_modules；配置、清单、Vite 与锁文件摘要和根工作树一致。日志和源码摘要保存在忽略目录 test-results/subtitle-studio-check-failures/，临时副本随后清理。源码摘要按修改/未跟踪文件去重排序、排除 docs、累积路径/NUL/字节/NUL，共 6 个文件。

## 风险与未执行项

三项指定问题全部完成，本轮没有扩大到其他旧问题或推进后续开发。旧版真实 ASR、含历史任务的原生恢复以及原定实机验证仍未执行，T06 和 I1 整体验收状态不变；本记录不把相关 282 项回归冒充全项目重跑或真实转写。此前全套与 Electron 证据保留在 [原集成记录](2026-09-10-workspace-06.md)。

本次只修改配置、检查清单、测试和记录，未改变界面，因此未新增截图验收或启动 Electron/Vite dev 服务；构建与测试进程均正常退出。按项目避坑要求，使用根 Vite 配置在源码副本构建，并检查真实 preload 输出。未调用模型 API、读取用户媒体或改动用户设置。
