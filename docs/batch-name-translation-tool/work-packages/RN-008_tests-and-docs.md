# 工作包 RN-008：测试与文档回填

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：未开始  
> 优先级：P0  
> 依赖：RN-001 至 RN-007

---

## 目标

补齐名称翻译工具的关键测试、回归验证和文档同步。该功能会真实修改文件系统，发布前必须有可复现的临时目录测试和 HomeAgent 意图区分测试。

---

## 范围

包含：

1. 主进程 rename 扫描和 apply 测试。
2. renderer planner 纯逻辑测试。
3. Agent 工具选择与确认测试。
4. 手动工具页关键路径测试。
5. 文档回填和最终偏差记录。

不包含：

1. 新功能开发。
2. 大规模 UI 重构。

---

## 测试文件建议

新增：

- `electron/main/rename/scanner.test.ts`
- `electron/main/rename/apply.test.ts`
- `electron/main/rename/journal.test.ts`
- `src/services/rename/nameSanitize.test.ts`
- `src/services/rename/nameConflict.test.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `src/agent/name-translation-intent.test.ts`
- `test/name-translation.e2e.spec.ts`

可更新：

- `src/agent/tool-schemas.test.ts`
- `src/agent/queue-batch.test.ts`

---

## 单元测试清单

### Scanner

1. 文件 self。
2. 目录 self。
3. children files。
4. children directories。
5. descendants maxDepth。
6. hidden 默认跳过。
7. `.git`、`node_modules` 默认跳过。
8. symlink directory 默认跳过。
9. maxTargets 截断。

### Planner

1. 保留扩展名。
2. 保留技术 token。
3. 清洗非法字符。
4. 空名称 blocked。
5. duplicate target blocked。
6. append_index 稳定。
7. target_exists blocked。
8. path_segments 缺少 startPath 时 clarificationRequired。

### Apply

1. 普通文件 rename。
2. 目录 rename。
3. case-only rename。
4. A/B swap。
5. 父目录和子文件同时 rename。
6. validation fail 时不执行。
7. apply 中途失败写 journal。
8. rollback 基础恢复。

### Agent

1. `翻译字幕` 使用字幕内容翻译。
2. `翻译文件名` 使用名称翻译。
3. 目录 `里面的文件名` 默认 children/files。
4. `递归` 才 descendants。
5. `整条路径` 追问。
6. `auto_execute` 不自动 apply rename。
7. apply 需要明确确认。

---

## E2E 手工/自动场景

临时目录树：

```text
tmp/
  日剧/
    第一季/
      第01話.srt
      第02話.srt
    メモ.txt
    .hidden.txt
    node_modules/
      package.json
```

场景：

1. 打开工具页。
2. 添加 `tmp/日剧`。
3. 选择 `children + files + EN`。
4. 生成预览。
5. 修改一项新名称。
6. 应用。
7. 检查文件系统。
8. rollback。
9. 检查恢复。

HomeAgent 场景：

1. 对话生成 plan。
2. 卡片展示 preview。
3. 确认 apply。
4. 查看结果。

---

## 文档回填

更新：

- `docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`
- `docs/batch-name-translation-tool/work-packages/README.md`
- 如实现与设计有偏差，新增：
  - `docs/batch-name-translation-tool/implementation-notes/`
  - 或在工作包文档底部追加「实现偏差」小节。

需要记录：

1. 最终 IPC 名称。
2. 最终路由。
3. plan store 过期策略。
4. 是否完整支持 `path_segments`。
5. rollback 限制。
6. 测试命令和结果。

---

## 发布前检查

1. `pnpm test` 通过。
2. `pnpm build` 通过。
3. 手动工具核心路径通过。
4. HomeAgent rename 路径通过。
5. 无真实用户目录被测试修改。
6. journal 文件位置可解释。
7. 文档与实际实现一致。

---

## 验收标准

1. 关键纯逻辑都有单元测试。
2. 真实 rename 在临时目录中有集成测试。
3. Agent 不误调用 rename/字幕翻译。
4. CI 或本地可复现所有验证命令。
5. 工作包 README 状态更新准确。
6. 最终设计文档没有与实现冲突的接口名称或行为描述。

---

## 交接说明

RN-008 不只是补测试。它要把实现和设计重新对齐，让下一个维护者不必从聊天记录里猜测真实行为。如果有功能延后，必须明确写成已知限制，而不是让文档保持理想化状态。

