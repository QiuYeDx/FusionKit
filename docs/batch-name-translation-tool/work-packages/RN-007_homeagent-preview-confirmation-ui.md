# 工作包 RN-007：HomeAgent 预览确认 UI

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：未开始  
> 优先级：P1  
> 依赖：RN-006

---

## 目标

让 HomeAgent 中的名称翻译 plan 以专门的预览确认卡片展示，而不是只显示 JSON 工具结果。用户可以在对话流中查看摘要、打开详情、确认应用或取消。

---

## 范围

包含：

1. HomeAgent 消息区展示 rename plan preview。
2. pending rename confirmation 卡片。
3. 确认/取消按钮。
4. 应用结果展示。
5. session log 中记录用户操作。

不包含：

1. 手动工具页完整预览表。
2. plan 生成核心逻辑。
3. Agent schema/executor。

---

## 主要文件

修改：

- `src/pages/HomeAgent/index.tsx`
- `src/store/agent/useAgentStore.ts`
- `src/agent/types.ts`
- 可能修改 `src/agent/session-io.ts`

可新增：

- `src/pages/HomeAgent/components/NameTranslationPlanCard.tsx`
- `src/pages/HomeAgent/components/NameTranslationApplyResultCard.tsx`

如果当前 `HomeAgent/index.tsx` 仍较大，建议借此只抽与 rename 相关的新组件，不做大规模拆分。

---

## UI 状态

卡片展示：

1. 标题：名称翻译预览。
2. planId 短 id。
3. 总目标数。
4. 可应用数量、冲突数量、跳过数量、无变化数量。
5. preview 前 5 至 10 项。
6. warnings。
7. 操作按钮：
   - 打开工具页查看完整预览。
   - 确认应用。
   - 取消。

当 `blockedCount > 0`：

1. 禁用确认应用。
2. 提示需要先去工具页处理冲突。
3. 保留打开工具页按钮。

当包含高风险项：

1. 确认按钮点击后再弹二次确认。
2. 二次确认展示影响数量和目录/递归风险。

---

## Store 行为

`confirmNameTranslationPlan(planId)`：

1. 检查 pending plan 存在。
2. 检查未 resolved。
3. 调用 apply 执行路径。
4. 更新 pending resolvedAction。
5. 添加 assistant/tool result 可读消息或状态。

`dismissNameTranslationPlan(planId)`：

1. 标记 resolvedAction=`dismiss`。
2. 保留历史消息，不删除 plan。

如果用户在对话中输入「确认执行刚才的重命名计划」，RN-006 的工具调用也能执行；RN-007 的按钮是 UI 快捷入口。

---

## 打开完整预览

可选实现：

1. 跳转 `/tools/rename/name-translator?planId=<planId>`。
2. 工具页加载 plan store 中的 plan。

如果跨页面 plan store 尚未准备好，先实现跳转到工具页并提示用户重新生成预览，不阻塞主确认链路。

---

## 实施步骤

1. 新增 `NameTranslationPlanCard`。
2. 在 HomeAgent 消息渲染逻辑中识别 `toolName === "create_name_translation_plan"` 的 tool result。
3. 将 pending plan 卡片放在输入框上方或消息流底部，位置参考现有 `PendingExecutionCard`。
4. 实现确认/取消按钮。
5. 接入高风险二次确认。
6. 实现 apply result 展示。
7. 验证 session 导出/导入不会因新增字段崩溃。

---

## 验收标准

1. create plan 后 HomeAgent 显示专用预览卡片。
2. preview 清楚展示原名称和新名称。
3. 有 blocked 项时不能确认应用。
4. 用户点击确认后才 apply。
5. 用户点击取消后不会 apply。
6. apply 结果显示成功/失败数量和 journalId。
7. 切换执行模式不改变 rename 必须确认的规则。

---

## 建议验证

```bash
pnpm test
pnpm build
pnpm dev
```

手工验证：

1. HomeAgent 生成 rename plan。
2. 查看卡片 preview。
3. 对有冲突的 plan 确认按钮禁用。
4. 对可应用 plan 点击确认。
5. 对另一个 plan 点击取消。
6. 导出/导入会话后页面不崩。

---

## 交接说明

RN-007 是 HomeAgent 的最后安全门。UI 的存在不是装饰，它要让用户在真实写入前看到足够信息。不要把卡片简化到只显示一个「确认」按钮。

