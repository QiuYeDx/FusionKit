# 工作包 RN-001：类型与 IPC 扫描能力

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：未开始  
> 优先级：P0  
> 依赖：无

---

## 目标

建立批量名称翻译工具的主进程基础能力：共享类型、路径检查、目标扫描、危险目录过滤、基础 IPC 注册。完成后，渲染进程和 HomeAgent 可以在不修改文件系统的前提下，知道用户给出的路径是什么、能影响哪些候选项、是否存在风险。

---

## 范围

包含：

1. 新增 `electron/main/rename/` 模块骨架。
2. 定义主进程使用的 rename 类型。
3. 实现 `inspect-rename-paths`。
4. 实现 `scan-rename-targets`。
5. 实现选择文件/文件夹的 IPC，可供手动工具页后续使用。
6. 在 `electron/main/index.ts` 注册 `setupRenameIPC()`。

不包含：

1. AI 名称翻译。
2. plan 冲突合并。
3. 真实 `fs.rename`。
4. HomeAgent 工具注册。
5. 完整 UI 页面。

---

## 主要文件

新增：

- `electron/main/rename/types.ts`
- `electron/main/rename/scanner.ts`
- `electron/main/rename/ipc.ts`

修改：

- `electron/main/index.ts`
- 如项目需要补充全局 IPC 类型，可修改 `electron/electron-env.d.ts` 或 `src/vite-env.d.ts`

---

## IPC 契约

### `select-rename-paths`

用途：打开系统选择器，选择文件和文件夹。

输入：

```ts
interface SelectRenamePathsParams {
  title?: string;
  buttonLabel?: string;
  allowFiles?: boolean;
  allowDirectories?: boolean;
  multiSelections?: boolean;
}
```

输出：

```ts
interface SelectRenamePathsResult {
  canceled: boolean;
  filePaths: string[];
}
```

实现要求：

1. 默认允许文件和文件夹。
2. 默认允许多选。
3. 不在此阶段做目标展开，只返回选择路径。

### `inspect-rename-paths`

用途：检查用户给出的路径类型与直接子项摘要。

输入：

```ts
interface InspectRenamePathsParams {
  paths: string[];
}
```

输出见最终设计文档 14.1。

实现要求：

1. 使用 `fs.lstat` 判断符号链接。
2. 使用 `fs.stat` 判断文件/目录。
3. 目录只统计直接子项数量，不递归。
4. 对不存在、无权限、非普通文件/目录返回 `riskLevel` 和 warnings，而不是抛出导致整批失败。

### `scan-rename-targets`

用途：按 `NameTranslationOptions` 展开候选目标。

输入：

```ts
interface ScanRenameTargetsParams {
  options: NameTranslationOptions;
  maxTargets?: number;
}
```

输出：

```ts
interface ScanRenameTargetsResult {
  targets: NameTranslationTarget[];
  totalCount: number;
  truncated: boolean;
  warnings: string[];
}
```

实现要求：

1. `scope=self`：只返回 root 本身。
2. `scope=children`：只返回目录直接子项。
3. `scope=descendants`：递归返回后代，遵守 `maxDepth`。
4. `scope=path_segments`：RN-001 只做基础路径检查，不负责完整 plan；缺少边界时返回 warning。
5. 按 `targetKind` 过滤文件/目录。
6. 默认跳过隐藏项和符号链接目录。
7. 默认阻止危险目录。
8. 对每个 target 填充 `id`、`kind`、`absolutePath`、`parentPath`、`originalName`、`stem`、`extension`、`depthFromRoot`、`anchorRoot`、`size`、`modifiedAt`。

---

## 危险目录规则

在 `scanner.ts` 中集中维护：

```ts
const BLOCKED_BASENAMES = new Set([".git", "node_modules"]);
const BLOCKED_ABSOLUTE_PATHS_DARWIN = ["/", "/System", "/Library", "/Applications", "/Users"];
const BLOCKED_ABSOLUTE_PATHS_WIN32 = ["C:\\", "C:\\Windows", "C:\\Program Files", "C:\\Users"];
```

注意：

1. 用户 Home 根目录默认应 `warning` 或 `blocked`，不要直接扫描。
2. 子目录中遇到 `.git`、`node_modules` 默认跳过。
3. 不要跟随符号链接目录，避免循环和越界。

---

## 实施步骤

1. 新建 `electron/main/rename/types.ts`，放置 IPC 入参/出参、target、options 的主进程类型。
2. 新建 `scanner.ts`：
   - `inspectRenamePaths(paths)`
   - `scanRenameTargets(params)`
   - `splitNameParts(name, kind)`
   - `isHiddenPathSegment(name)`
   - `isBlockedPath(path, homeDir)`
3. 新建 `ipc.ts`，导出 `setupRenameIPC()`。
4. 在 `electron/main/index.ts` 中 import 并调用 `setupRenameIPC()`。
5. 为扫描逻辑添加单元测试骨架，至少覆盖纯函数；依赖 Electron 的 dialog 可在后续集成测试补。

---

## 验收标准

1. `inspect-rename-paths` 能返回文件、目录、不存在路径、无权限路径的结构化结果。
2. `scan-rename-targets` 能正确处理 `self`、`children`、`descendants`。
3. 默认不会递归扫描隐藏目录、`.git`、`node_modules`、符号链接目录。
4. 目录扫描达到 `maxTargets` 后返回 `truncated=true`。
5. 没有真实重命名行为。

---

## 建议验证

```bash
pnpm test
pnpm build
```

手工验证：

1. 创建临时目录树，包含文件、目录、隐藏项、`.git`、`node_modules`。
2. 在渲染进程临时调用 IPC 或通过后续 UI 验证 inspect/scan 返回结果。
3. 检查扫描结果中的 `depthFromRoot`、`anchorRoot` 是否稳定。

---

## 交接说明

RN-001 完成后，RN-002 可以直接调用 `scan-rename-targets` 获取候选目标，不再重复实现目录遍历逻辑。后续如果安全目录规则需要调整，应优先修改 `scanner.ts`，不要在 UI 或 Agent 中复制一份规则。

