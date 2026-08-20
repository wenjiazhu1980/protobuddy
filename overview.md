# 任务概览：按批注分批生成方案

**提交**: main · 4 个文件改动 · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dpruw10gisvj）

## 背景

上一轮将非推理模型输入预算扩到 350k 字符后，单个大型原型项目（如项目 3 的 phase-2 多页面站点）仍有上下文不足风险：文件太大、批注太多时，预算守卫会省略关键文件，导致 `old_code` 匹配质量下降。继续堆字符会撞上 Cloud Function 120s 硬超时——本方案改为**按批注分批生成**：每批只带自身相关文件上下文，彻底绕开单次输入窗口瓶颈。

## 功能设计

### 1. 触发条件（auto 自动）

- **非推理模型**（deepseek-chat / @makers/hy3）——推理模型太慢，多批调用会超 120s
- open 批注数 ≥ **6 条**
- 全量上下文估算（批注文本 + 候选文件字符数）超过输入预算的 **85%**

### 2. 分批算法

- 按页面分组（同页批注尽量同批），贪心打包，每批 ≤ **5 条**批注；单页批注超限时单独切分
- 每批用 `makeRank(该批页面)` 重新选取文件：目标页面(0) > 同目录(100) > 生成器脚本(300) > 无关文件(999)，只携带该批真正相关的文件

### 3. 合并与质量保障

- 每批独立调用模型后：changes 拼接、contextMeta 聚合（文件数/prompt 字符/估测 token/输出 token 求和，warnings 带 `[批N]` 前缀）、summary 汇总「N 批生成共 X 条修改覆盖 Y 条批注」
- 合并结果继续走全量 dry-run 预检、批注一致性检查、评分卡——与单批生成同一套质量门禁
- 分批模式跳过全量 auto-retry（时间预算不允许），每批失败自动用规则引擎兜底该批

### 4. 显式控制

- `?batch=force` 强制分批（小项目测试/用户手动控制）
- `?batch=off` 关闭分批（保持单批）
- 默认 `auto` 自动判断

### 5. 前端展示

- 方案审核页 context_meta 横幅显示紫色「N 批生成」徽章
- 底部摘要行显示「分批生成 N 批」

## 验证情况

- **单测**：buildBatches（7 条跨 3 页 → 2 批每批 ≤5；单页 12 条 → 5/5/2）、makeRank 排序、estimatePromptChars 估算均正确
- **本地 E2E**（项目 1，deepseek-chat，7 条 open 批注）：
  - `?batch=force` → batched=true, batch_count=2, 7 条 changes，summary/contextMeta 正确合并
  - auto 模式 + 预算 5000 → 自动触发分批（est 4779 > 5000×85%）
  - `?batch=off` → 单批正常
  - 测试批注/方案已清理，项目数据恢复原状
- 后端语法、前端构建通过；线上部署 `dpruw10gisvj`，protobuddy.20140107.xyz 200

## 文件变更

- `backend/src/routes/plans.js`：新增 makeRank / groupByPage / buildBatches / estimatePromptChars（导出供单测）；分批生成主流程；plan 记录 batched/batch_count；分批模式跳过 auto-retry
- `backend/src/services/makersModels.js`：导出 INPUT_CHAR_BUDGET 供 plans.js 判断
- `frontend/src/pages/PlanReview.jsx`：「N 批生成」徽章 + 底部生成方式

## 后续事项

1. 分批后每批仍受 120s 硬超时约束——批数较多时建议用更快的非推理模型，或对超大单页项目继续做「函数级片段精读」。
2. 推理模型暂不参与分批；如需支持，可考虑串行但每批更小（每批 2-3 条）并严格检测剩余时间预算。
