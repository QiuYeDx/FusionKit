# 工作包 RV-001：Dirent 快路径丢失 symlink 检测

## 基本信息

- 日期：2026-06-22
- 状态：已完成
- 对应执行计划工作包：RV-001

## 本次实现内容

- 在 `getPathInfoFromDirent()` 中增加 `entry.isSymbolicLink()` 前置检查，symlink 条目 fallback 到 `getPathInfo()` 走完整 `lstat` + `stat` 路径。
- 非 symlink 的普通文件/目录仍走 Dirent 快路径，不额外调用 `lstat`。
- 新增测试用例验证 symlink directory 在 children scope 下被正确检测和跳过，symlink file 仍可作为目标扫描，且两者都触发 `lstat` 调用。

## 修改文件

- `electron/main/rename/scanner.ts` — `getPathInfoFromDirent()` 增加 symlink 前置检查
- `test/rename/scanner.test.ts` — 新增 "detects symlink directories via dirent and skips them in children scan" 测试

## 接口或数据结构变化

无。`PathInfo` 和 `getPathInfoFromDirent` 签名不变。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/scanner.test.ts
```

结果：

- 13 tests passed (含新增 symlink 测试)
- Duration: 209ms

## 未完成事项

无。

## 下一步建议

继续 RV-002：`checkRenameTargetsExist` 丢弃 errors。
