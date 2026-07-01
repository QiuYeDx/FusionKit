# 工作包 FE-005：Renderer Markdown 文件开放与 Beta 提示

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`FE-005`

## 本次实现内容

- 文件选择器 `accept` 开放：
  - `.txt`
  - `.md`
  - `.markdown`
  - `text/plain`
  - `text/markdown`
- Renderer 文件扩展名校验支持 TXT 和 Markdown，不支持格式使用统一错误提示。
- `SelectedTextFile` 增加 `format`，恢复任务映射保留主进程文件格式。
- 文件顺序列表增加 TXT / Markdown 格式 Badge，mixed ordered project 不做额外阻断。
- 选择 Markdown 后显示 Beta 提示：
  - 代码、URL、frontmatter、HTML 会被保护。
  - 5 MB 为软警告阈值。
  - 10 MB 为当前硬限制。
  - 复杂 Markdown 发布前建议检查输出。
- 更新当前 Beta 范围，明确支持：
  - 单个或多个 TXT / Markdown。
  - parallel / continuity serial。
  - target-only / bilingual。
- 同步中文、英文、日文、繁体中文文案，移除“仅 TXT”和“Markdown 后续接入”等过期描述。

## 修改文件

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_markdown-e2e-gap.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-24_FE-005_renderer-markdown-entry.md`

## 接口或数据结构变化

- Renderer 内部 `SelectedTextFile` 新增 `format: TextFileFormat`。
- 新增 `detectSelectedTextFileFormat()`，只接受 `.txt`、`.md`、`.markdown`。
- 未修改 IPC DTO；Renderer 仍只向主进程传递路径、相对路径和顺序，由主进程重新检查文件格式。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- i18n：8 namespaces / 931 keys，全语言完整性检查通过。
- 共享类型、IPC、Renderer execution service：3 files / 15 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；保留项目既有动态/静态 import、chunk size 和未签名 macOS 打包警告，DMG/ZIP 及 block map 正常生成。
- `git diff --check`：通过。

## 未完成事项

- 本包未启动前端开发服务，也未执行浏览器/桌面应用点击冒烟。
- `.md` 选择、拖拽、mixed ordered project、Markdown Beta 提示的真实 UI 操作由 `QA-MD-001` 统一验收。
- README/CHANGELOG 仍保留 Markdown 未开放限制，由 `DOC-MD-001` 在 QA 后同步。

## 下一步建议

- 下一包认领 `QA-MD-001`，将主进程自动化、复杂 Markdown fixture 和 Renderer 可见入口作为一个整体门槛验收。
