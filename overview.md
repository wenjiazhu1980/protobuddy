# 任务概览：空修改拒绝防护（old_code === new_code）

**提交**: main 594a565 · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dpwzxhr75cdf）

## 背景

用户要求检查方案 #627 是否真正修改成功。排查发现：该方案两条修改建议的 `old_code` 与 `new_code` 完全相同（都是带 `disabled` 的同一行 HTML），`replace(old, new)` 没有改动任何字符，但方案被标记为「已应用」、评分卡 100 分、批注被 resolve——一次**静默空应用**。预检只校验 `old_code` 能否唯一匹配，不校验是否产生实际变更。用户确认后要求加上「空修改拒绝」防护。

## 改动方案（backend/src/routes/plans.js）

### 1. 生成时预检：`precheckChanges`

`old_code === new_code` 时直接标记为 `error`：

- 提示「修改建议未产生实际变更（old_code 与 new_code 完全相同）。目标可能已达成，请重新描述需求或关闭对应批注」。
- error 会自动进入评分卡（needs_review）与自动重试反馈回路；前端 PlanReview 的红色预检徽章与「预检未通过」提示自动展示该消息，无需前端改动。

### 2. 应用时硬校验：`POST /plans/:planId/apply`

在文件存在性/唯一匹配校验之前增加等值守卫：

- `old_code === new_code` → 该条拒绝应用，写入 errors，回滚到 `approved` 状态，整个 apply 返回 HTTP 409。
- 提示语附带处理建议：目标可能已达成，建议驳回该条建议并关闭对应批注，或创建更明确的批注。
- 批注不会被错误 resolve，快照机制照常工作。

## 验证情况

本地 3001 端口真实 E2E 冒烟测试：

1. 创建测试项目 → 写入 `index.html` → 创建批注 → 生成规则引擎方案。
2. 篡改 db.json 将 change 的 `new_code` 设为与 `old_code` 相同（且该代码真实存在于文件中），重启后端加载。
3. 调用 apply → **HTTP 409**，`appliedCount: 0`，错误消息正确，快照正常创建，plan 状态回滚为 approved，批注未被 resolve。
4. 测试项目与残留数据（planChanges/snapshots）已全部清理。

其余验证：

- `node --check` 语法通过。
- EdgeOne Makers 部署成功：`dpwzxhr75cdf`，线上 `/api/health` 200。
- 代码已提交并推送 GitHub：`594a565`。

## 文件变更

- `backend/src/routes/plans.js`：`precheckChanges` 增加 old/new 相等报错分支；apply 端点增加空修改拒绝守卫（+21/-7 行）。

## 后续事项

1. 方案 #627 属于历史空应用，其对应批注目标（下拉框 disabled）实际已达成，建议直接关闭该批注。
2. 历史上其他标记「已应用」但可能同样为空应用的方案，如需排查可用 `old_code === new_code` 条件批量扫描 plans 数据。
