# 任务概览：批注栏底部固定 + 筛选感知导出

**提交**: `6477048` (main) · 3 个文件 · +257/-24 行 · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dpwfgre0mx0m）

## 功能说明

优化评审页右侧批注栏的布局与导出能力，解决底部操作按钮被挤出可视区、以及无法按当前视图导出批注的问题。

### 1. 底部固定与高度约束

- **外层布局**：`Review` 页的 `main-content` 改为 `display: flex; flex-direction: column; height: 100%`，顶部标题行自然占用高度，`.review-layout` 通过 `flex: 1; min-height: 0` 填满剩余视口空间，不再依赖 `calc(100vh - ...)` 硬编码。
- **面板布局**：`.annotation-panel` 改为 `display: flex; flex-direction: column; overflow: hidden; min-height: 0`。
- **滚动容器**：新增 `.annotation-list`，负责 `flex: 1; overflow-y: auto; min-height: 0`，只有批注列表本身滚动；标题栏、筛选器、排序器、底部操作栏均不滚动。
- **底部操作栏**：新增 `.annotation-panel-footer`，`flex-shrink: 0`，始终固定在面板底部，包含「生成修改方案」与「导出」两组操作。

### 2. 排序状态

新增排序选择器（位于筛选器下方）：

| 排序项 | 行为 |
|---|---|
| 默认顺序 | 保持后端返回顺序 |
| 时间倒序 | 按 `created_at` 从新到旧 |
| 时间正序 | 按 `created_at` 从旧到新 |
| 状态排序 | 待处理 → 已解决 → 不采纳，同状态下时间倒序 |

### 3. 筛选感知的导出

- **导出入口**：底部操作栏内的格式下拉 +「导出」按钮。
- **格式支持**：
  - **JSON**：`application/json;charset=utf-8`，无 BOM， pretty-print（2 空格）。导出的 JSON 包含 `exportedAt`、`filter`、`sort`、`total` 元信息及 `annotations` 数组，数组字段为 `id/content/status/author/page/x/y/created_at/element_info`。
  - **CSV**：`text/csv;charset=utf-8`，带 UTF-8 BOM（`\uFEFF`），便于 Windows Excel 正确识别中文；字段包含逗号/引号/换行时按 RFC 4180 转义；`element_info` 用 `JSON.stringify` 整段写入。
- **数据范围**：严格使用当前经过筛选 **和** 排序后的 `filtered` 数组，不会导出全部批注。文件名包含项目名、筛选标签、排序标签和时间戳，例如 `批注_优美丝路_待处理_时间倒序_20260820_094556.json`。

## 验证情况

- `npm run build` 通过，产物 `dist/assets/index-CJXdV5AY.js` 包含新代码。
- 本地静态预览（`python3 -m http.server 5175`）页面与 JS 资源 200 正常。
- `git push` 因 HTTP 代理 502 失败一次，随后使用 `git -c http.proxy= -c https.proxy= push` 成功。
- EdgeOne 部署成功：`dpwfgre0mx0m`；自定义域名 `protobuddy.20140107.xyz` 返回 200，线上 JS bundle 确认包含 `annotation-panel-footer`、`annotation-export`、`批注_` 等标记。

## 文件变更

- `frontend/src/components/AnnotationLayer.jsx`：新增排序状态、导出逻辑、固定底部操作栏，使用 `useMemo` 计算筛选+排序结果。
- `frontend/src/pages/Review.jsx`：传递 `projectName`；为外层容器与 `.review-layout` 设置 flex 列布局。
- `frontend/src/styles.css`：新增/调整 `.annotation-list`、`.annotation-panel-footer`、`.annotation-sort`、`.annotation-export`、`.review-layout` 等样式。

## 后续事项

1. 当前导出由前端在浏览器中完成，适合批注量 < 10k 的场景；若后续需要服务端导出（如一次性导出全项目历史），可复用同样的筛选/排序逻辑在后端实现。
2. 本地 3001 后端仍在运行。
