# Electron 验证入口

命令在仓库根目录执行。按影响范围选用，不要求每次微调运行全部测试。

## 已有检查

| 范围 | 入口 | 证据边界 |
| --- | --- | --- |
| 字幕工作台 | `test/subtitle-studio/workspace-ui.test.ts` | 隔离原生文件流程、分页、复制替代、视图、长短文件名 Tooltip、密度、窗口与主题 |
| 共用间距 | `test/tool-spacing.electron.test.ts` | 11 个工具页、相关面板/上传区、深浅主题、1280/786 窗口及折叠状态；不等于全部业务验证 |
| 共用控件 | `src/pages/Tools/_shared/ui/` 下相关测试 | 交互/消费契约检查；源码字符串断言不能证明视觉正确 |
| 本地字幕页 | `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts` | 局部页面契约，可搭配实际展开状态截图 |

使用本地二进制，先确认项目包管理器版本；本轮环境为 pnpm 8.7.0，但以后仍应读取环境/项目约定，不能为运行测试顺带更新 lockfile。

```sh
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
FUSIONKIT_STUDIO_E2E=1 node_modules/.bin/vitest run test/subtitle-studio/workspace-ui.test.ts
FUSIONKIT_TOOL_UI_E2E=1 node_modules/.bin/vitest run test/tool-spacing.electron.test.ts
```

根 Vite 配置同时构建 renderer、main、preload。不要发明单独配置文件，也不需要为 CSS 小改动打包安装程序。按项目配置做类型检查；如果遇到既有解析模式问题，可用补充检查定位，但不能把改变 moduleResolution 的结果称为默认检查已通过。

改动界面文案时运行 `pnpm run i18n:check`（确认 pnpm 版本后），区分 locale parity 和源码使用检查。不能用已知旧错误作为以后所有检查失败的默认解释。

## 截图是否有效

- 等 `.app-loading-wrap` 和 `#app-loading-style` 都退出，再确认目标路由与数据。
- Electron 窗口受最小宽度限制，786px 是当前真实窄窗口参照；390px renderer 只能作为额外布局探测，不能称为手机原生验证。
- 主题写入后重新加载并检查 `html.dark`；不要仅看 localStorage 值。
- 页面使用内部 ScrollArea。滚动实际目标，检查 `getBoundingClientRect()` 和最终截图，确保本次验收的标题/控件没有被固定顶部壳层与底部导航覆盖。
- Tooltip 测试必须打开后查看框与文字；文件列表截图必须包含长文件名，密度截图必须包含短行与多行。不能只积累空状态截图。
- 圆角附近的按钮需量到外壳相邻两边的距离，并查看曲线局部截图；原有间距测试通过不代表满足最新等距要求。分页栏同时检查高度、侧向留白和焦点，不能只断言 `py-1` 或一个高度上限。
- 截图目录通常是 `test-results/subtitle-studio-ui/`、`test-results/tool-spacing/`；目录已忽略，不能把旧图片存在当成这次验证通过。
- 收尾关闭测试创建的隔离 Electron profile 与服务，检查进程；不关闭用户原有 Electron。

## 关联避坑记录

按需阅读已有记录，避免复制并产生两份冲突流程：

- [加载层](../../fusionkit-pitfall-guard/references/electron-visual-qa-wait-for-loading.md)
- [真实滚动容器与遮挡](../../fusionkit-pitfall-guard/references/electron-visual-qa-scroll-active-container.md)
- [进程清理](../../fusionkit-pitfall-guard/references/frontend-service-cleanup-before-final.md)
- [根 Vite 构建](../../fusionkit-pitfall-guard/references/use-the-root-vite-config-for-electron-build-validation.md)
- [圆角实际计算值](../../fusionkit-pitfall-guard/references/verify-radius-tokens-in-computed-styles.md)
- [窄窗口工作流顺序](../../fusionkit-pitfall-guard/references/keep-primary-tool-workflow-first-on-narrow-layouts.md)
