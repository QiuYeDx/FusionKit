# I1 依赖门禁与接续文档收尾

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-08 既有边界/验证补漏 |
| 日期 | 2026-09-11 |
| 验证版本 | 3a0f50ed15c1b63451402cecf27240182235e567 加本次 boundaries.json / boundaries.test.ts 工作树修改 |
| 环境 | macOS arm64；Node 20.19.5、已安装 Vitest 2.1.9；直接 Node 入口，未运行 pnpm |
| 授权 | 当前进度盘点后用户原文“好的，继续往后推进工作吧”；先收尾 I1，再推进 I2 |

## 实际结果

进度盘点的独立检查报三项 Unaudited package：StudioTranslation、StudioExport 引入 react-dom，共享 dropdown-menu 引入 @radix-ui/react-dropdown-menu。原来的两个边界测试只覆盖公共IPC列表及临时合成依赖图，因此同一次盘点的333项模块测试可以通过，而真实仓库门禁失败。

两处 createPortal 只把操作触发按钮放入响应式槽位，保持批量控制器和对话框挂载；共享 Radix 菜单只负责导出及选择范围的菜单、Portal、焦点行为。确认属于通用 UI 后补两项准确包名称，没有放宽旧字幕源码/IPC/资源限制，也没有改变产品运行代码。

新增真实仓库图回归，先准确复现三条错误，再补清单使其通过。仓库根由测试模块URL解析，不依赖运行目录或平台路径写法，既有直接/传递/type/dynamic/helper/资源负例保留。已补项目避坑 FK-PIT-0130，要求合成负例与实际来源图都验证。

文档更新当前集成事实：a742746、2878b94、d5e98d4、3a0f50e 已提交，历史验证记录中的“未提交”保留当时含义。README 改为当前状态和真正下一步，旧测试证据集中引用；I1 acceptance 仍 pending。spec.json 登记本次继续指令 A-07，允许按先前说明进入 I2 的第一项来源冻结，不将旧 A-06 停止边界误用为本轮阻塞。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实源码边界 | 通过 | inline: node scripts/subtitle-studio/check-boundaries.mjs，130 files / errors [] |
| 边界负例及真实仓库回归 | 通过 | inline: boundaries.test.ts 3/3通过；新增真实仓库用例在修复前失败并准确列出三项缺失依赖 |
| 工作台模块回归 | 通过 | inline: 17 files / 334 passed，1个条件布局测试跳过；9.83s；明确排除GUI、真实API和私有文件测试 |
| TypeScript | 通过 | inline: 根tsconfig --noEmit --incremental false，以及tsconfig.node --incremental false --composite false均exit 0，无构建缓存 |
| i18n | 通过 | inline: 四语完整性通过，18条既有同值提示；1986调用、1980个已解析源码键均有效 |
| 规格接续 | 通过 | inline: 2.1.0 checker对新I2范围执行ready --require-approval，0 error / 0 warning；当前用户授权登记于A-07 |

复现模块回归：

```sh
node node_modules/vitest/vitest.mjs run test/subtitle-studio --exclude '**/*ui.test.ts' --exclude '**/electron.test.ts' --exclude '**/translation-real-api.test.ts' --exclude '**/bilingual-local-files.test.ts' --reporter=dot
node scripts/subtitle-studio/check-boundaries.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json --incremental false --composite false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
```

## 风险与未执行项

本轮只有审计/测试和文档修改，未重跑无变化的Electron视觉、真实供应商、原生推理、删除演练或发布安装包。历史2069项及各轮GUI数字不重复算作本次通过。未安装依赖、未修改package/lockfile、未启动前端或模型服务；无本次服务需要终止。I2 来源冻结另有任务/记录，不将此门禁修复描述成新版原生运行时已就绪。
