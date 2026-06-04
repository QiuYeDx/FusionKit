# 工作包 RN-005：工具入口与 i18n

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：已完成
> 优先级：P1  
> 依赖：RN-004 可并行后半段

---

## 目标

把「文件名/文件夹名翻译」从 Coming Soon 变成真实可访问工具，并补齐中文、英文、日文界面文案和路由标题。

---

## 范围

包含：

1. 工具列表入口。
2. 路由注册。
3. 工具 metadata 更新。
4. i18n 文案。
5. README 或 changelog 的功能说明可选更新。

不包含：

1. 工具页内部复杂交互，这属于 RN-004。
2. Agent 接入，这属于 RN-006/RN-007。

---

## 主要文件

修改：

- `src/pages/Tools/index.tsx`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/constants/router.ts`
- `src/App.tsx`
- `src/locales/zh/tools.json`
- `src/locales/en/tools.json`
- `src/locales/ja/tools.json`
- 可选：`README.md`
- 可选：`CHANGELOG.md`

新增或引用：

- `src/pages/Tools/Rename/NameTranslator/index.tsx`

---

## 路由设计

推荐路由：

```text
/tools/rename/name-translator
```

更新点：

1. `src/App.tsx` import 页面并添加 Route。
2. `src/constants/router.ts` 添加菜单标题映射。
3. `toolMeta.ts` 中新增或调整 rename 子工具的 route。

当前 `ToolKey` 只有 `rename` 作为 Coming Soon 分类占位。实施时有两种方案：

1. 保持 `rename` 作为工具 key，并把它指向 `name-translator` 页面。
2. 新增 `nameTranslator` key，让 `rename` 继续表示分类。

推荐方案 2，更利于未来继续加入其他重命名工具：

```ts
export type ToolKey =
  | "translator"
  | "converter"
  | "extractor"
  | "music"
  | "nameTranslator";
```

分类仍使用：

```ts
category: "rename"
```

---

## 工具列表文案

中文建议：

```json
{
  "fields": {
    "name_translator": "文件名/文件夹名翻译"
  },
  "field_desc": {
    "name_translator": "批量翻译文件和文件夹名称，先预览再安全重命名"
  }
}
```

英文建议：

```json
{
  "fields": {
    "name_translator": "Name Translator"
  },
  "field_desc": {
    "name_translator": "Batch translate file and folder names with a safe preview before renaming"
  }
}
```

日文建议：

```json
{
  "fields": {
    "name_translator": "ファイル/フォルダ名翻訳"
  },
  "field_desc": {
    "name_translator": "ファイルやフォルダ名を一括翻訳し、プレビュー後に安全にリネームします"
  }
}
```

---

## UI 入口规则

1. `重命名工具箱` 不再只展示 Coming Soon。
2. 新卡片显示新工具名称、描述、图标和可点击状态。
3. 如果未来仍要保留 Coming Soon 的其他重命名工具，占位卡片可以作为第二个 item。
4. 点击卡片跳转到 `/tools/rename/name-translator`。

---

## 实施步骤

1. 在 `toolMeta.ts` 中增加 `nameTranslator` metadata，状态为 `stable`。
2. 在 `Tools/index.tsx` 的 rename section 中替换 Coming Soon item。
3. 在 `App.tsx` 注册 Route。
4. 在 `router.ts` 添加 route name key。
5. 更新三份 `tools.json`。
6. 如需要，为页面内部新增独立 namespace，可新增 `src/locales/*/rename.json` 并更新 `src/i18n/constants.ts`、`src/i18n/resources.ts`。如果文案较少，先放在 `tools.json` 和页面局部 fallback 即可。

---

## 验收标准

1. 工具列表中出现可点击的名称翻译工具。
2. 点击后进入新工具页。
3. 底部导航和页面切换动画正常。
4. 中文、英文、日文切换时入口文案正确。
5. 没有遗留 `Coming Soon` 状态误挡新工具。

---

## 建议验证

```bash
pnpm build
pnpm dev
```

手工验证：

1. 访问 `/tools`。
2. 点击重命名工具箱中的新卡片。
3. 直接访问 `/tools/rename/name-translator`。
4. 切换语言检查文案。

---

## 交接说明

RN-005 不应修改 rename 核心逻辑。它只负责让 RN-004 的页面被稳定访问，并确保多语言入口不会破坏已有字幕工具入口。

---

## 实施结果

- 完成日期：2026-05-21
- 实施记录：`docs/batch-name-translation-tool/implementation-records/2026-05-21_RN-005_tool-entry-and-i18n.md`
- 关键文件：
  - `src/pages/Tools/_shared/toolMeta.ts`
  - `src/pages/Tools/index.tsx`
  - `src/i18n/constants.ts`
  - `src/i18n/resources.ts`
  - `src/locales/zh/tools.json`
  - `src/locales/en/tools.json`
  - `src/locales/ja/tools.json`
  - `src/locales/zh/rename.json`
  - `src/locales/en/rename.json`
  - `src/locales/ja/rename.json`
  - `src/pages/Tools/Rename/NameTranslator/*`
  - `src/store/tools/rename/useNameTranslatorStore.ts`
- 验证：
  - `pnpm exec tsc --noEmit`
  - `pnpm exec vitest run test/rename src/services/rename`
  - `pnpm build`
  - `pnpm dev` 启动通过；Electron 点击冒烟本轮受 Computer Use 授权限制，未计入已完成验证。
- 说明：
  - 采用推荐方案 2：新增 `nameTranslator` 工具 key，分类仍为 `rename`。
  - 重命名工具箱已展示可点击的名称翻译工具，不再使用 Coming Soon 占位。
  - 新工具页和 store 的用户可见文案迁入 `rename` namespace，中英日均已补齐。
