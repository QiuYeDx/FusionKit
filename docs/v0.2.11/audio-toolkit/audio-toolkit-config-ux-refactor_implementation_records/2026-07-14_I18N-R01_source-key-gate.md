# 工作包 I18N-R01：源码翻译 key 门禁与 legacy 文案清理

## 基本信息

- 日期：2026-07-14
- 状态：已完成
- 对应执行计划工作包：`I18N-R01`

## 本次实现内容

- 新增 TypeScript AST usage checker，绑定 `useTranslation`、共享 `i18n.t`、typed
  translator helper 与 `Trans`，有限展开静态分支、union template、常量 map 和 metadata。
- 新增 exact dynamic manifest；未知动态表达式、通配符、过期 selector 与 fallback-only
  缺 key 均作为错误，自测覆盖多冒号、非翻译 `t`/IPC 字面量与上述失败合同。
- 补齐四语言 55 组原来只依赖中文 `defaultValue` 的 Rename/Subtitle Tour 与模型提示；
  清理每语言 85 个无生产消费者的 legacy audio/setting leaf。
- 字幕提取器 key 统一为 `subtitle:extractor.*`；i18next 多冒号兼容仍由 checker 测试保护。
- PendingExecution widget 的外部 `labelKey` 收紧为三项 literal union 和运行时白名单，
  HomeAgent 删除未知 store 名直接进入 `t()` 的 fallback。
- Electron raw-key smoke 检查正文及 `aria-label/title/placeholder/alt`，覆盖 standalone
  音频设置、添加/编辑弹窗、四个音频路由和四语言两尺寸矩阵。
- `i18n:check` 串联 locale 与 usage 两层门禁；同步 i18n 规范、Final Design、执行台账和
  FusionKit i18n/Zustand pitfall。

## 修改文件

- `scripts/check-i18n-usage.mjs`
- `scripts/i18n-usage-manifest.mjs`
- `scripts/check-i18n-usage.test.mjs`
- `package.json`
- `src/locales/{zh,zh-Hant,en,ja}/{audio,setting,rename,subtitle}.json`
- `src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx`
- `src/store/tools/subtitle/useSubtitleExtractorStore.ts`
- `src/components/qiuye-ui/markdown-renderer/widgets/PendingExecutionWidget.tsx`
- `src/components/qiuye-ui/markdown-renderer/widgets/PendingExecutionWidget.test.tsx`
- `src/pages/HomeAgent/index.tsx`
- `test/e2e.spec.ts`
- `docs/i18n-best-practices.md`
- `.agents/skills/fusionkit-pitfall-guard/references/*`
- 本主题 Final Design、Execution Plan 与版本级台账

## 接口或数据结构变化

- `PendingExecutionStoreItem.labelKey` 从任意 `string` 收紧为三项
  `PendingExecutionStoreLabelKey`；不受信任的 widget payload 会在解析阶段拒绝未知 key。
- 新增 `I18N_USAGE_MANIFEST` 的 `file#argument-expression -> exact keys` 维护合同。
- `pnpm run i18n:check` 现在同时执行 locale parity 与源码 usage；可用
  `i18n:check:locales` / `i18n:check:usage` 分别排查。
- 未改变音频 IPC、Store 持久化或运行时 task payload。

## 验证结果

执行命令：

```text
node --test scripts/check-i18n-usage.test.mjs
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vitest run src/components/qiuye-ui/markdown-renderer/widgets/PendingExecutionWidget.test.tsx
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --exclude test/e2e.spec.ts
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'audio pages render across languages and window sizes without white-screen regressions'
git diff --check
```

结果：

- checker 自测 7/7；真实扫描 1342 calls，其中 1310 static/type-finite、32 次
  manifest-backed，1378 个实际引用 key 全部可解析。
- 四语言各 1484 key：audio 352、setting 213、rename 185、subtitle 332；仅保留原有
  9 条 same-as-source 专名/格式 warning。
- PendingExecution 定向 1/1；全量非 Electron 89 files / 808 tests 通过。
- TypeScript 与 Vite renderer/main/preload test build 通过；构建只有既有 dynamic import
  和 chunk-size warning。
- Electron targeted 1 test 通过、6 tests 按名称过滤；该测试内部覆盖 4 locales × 2 sizes
  × 4 audio routes，并等待 preload loading 完全退出。
- 仅确认当前 pnpm 为 8.7.0，验证直接使用 `node` 与 `node_modules/.bin/*`；
  `pnpm-lock.yaml` 未修改。
- Electron/fake server 由 E2E `afterAll` 关闭；最终回复前再次检查项目进程表为空。

## 未完成事项

- `TEST-R01`、`QA-R01`、`QA-R02` 与 `DOC-R01` 保持独立工作包。
- 本次 Electron 只闭环 raw-key 四语言尺寸矩阵，不提前替代完整交互矩阵或真实设备验收。

## 下一步建议

- 进入 `TEST-R01`，先对照设计 §12 盘点已覆盖与缺失的 migration、registry、runtime、
  request builder 和 component 自动化，再只补真实缺口，避免重复已有 808 项回归。
