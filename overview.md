# 任务概览：Agent 输入/输出上下文限制提升 + 截断预警机制

**提交**: main · 3 个文件改动 · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dpoe58322lll）

## 功能说明

提升 Agent（Makers Models 方案生成链路）的上下文容量，并在接近长度上限时给出可视化预警，取代原有的静默截断。

### 1. 输入上下文窗口扩容（集中化、env 可覆盖）

- 新增集中配置 `CONTEXT_LIMITS`（makersModels.js 顶部），取代散落的内联限制：
  - 推理模型（deepseek-v4 / kimi-k2 / minimax）：单文件 12k→**20k 字符**，文件数 6→**8**
  - 非推理模型（deepseek-chat / @makers/hy3）：单文件 30k→**50k 字符**，文件数 10→**14**
- `plans.js` 文件选取上限同步改为模型分层（`CONTEXT_LIMITS[tier].maxFiles`，按 `project.makers_model` 判定层级）。
- 全部参数支持环境变量覆盖，无需改代码即可调参：
  `MAKERS_CTX_FILE_CHARS(_REASONING)`、`MAKERS_CTX_MAX_FILES(_REASONING)`、`MAKERS_MAX_OUTPUT_TOKENS(_REASONING)`、`MAKERS_INPUT_CHAR_BUDGET(_REASONING)`。

### 2. 输出 token 上限提升

- 推理模型 `max_tokens` 8000→**16000**（reasoning_content 与 content 共享预算，给足空间避免 JSON 被切断）；非推理模型 4000→**8000**。

### 3. 截断预警机制（而非直接截断）

- **输入侧**：组装完 prompt 后实测字符数与估测 token 数（CJK≈1 token、其他≈4 字符/token）；超过打包预算（推理 110k / 非推理 190k 字符）时按相关性**从尾部丢弃文件**并记录 `files_omitted` 明细；超过预算 85% 记录预警；大文件仅含摘录的记录 `files_truncated`。
- **输出侧**：
  - `finish_reason=length` 且 JSON 解析失败时，`repairTruncatedPlanJson` 从最后一个完整 `},` 对象边界向后尝试闭合 JSON，**抢救截断前已完整输出的修改建议**（而非整体丢弃走兜底），标记 `output_truncated=true` 并预警"方案可能不完整"；
  - 输出用量 ≥ 85% 上限时预警"接近输出上限，复杂任务建议分批生成"。
- **数据链路**：`contextMeta`（文件数/省略与截断明细/prompt 字符/估测 token/finish_reason/completion_tokens/warnings）随生成结果持久化到 `plan.context_meta`。
- **前端**（PlanReview.jsx）：方案摘要下方新增横幅——正常时灰色显示上下文用量概览（输入~tokens、文件数、输出 tokens），有预警时黄色逐条列出，输出被截断时红色高亮提示核对。

## 验证情况

- 单测：截断 JSON（3 条 change 切尾）抢救出 2 条完整对象（含字符串内花括号边界跳过）；垃圾输入返回 null；token 估算与模型分层判定正确。
- E2E（本地项目 1，deepseek-chat）：生成 plan #10078，`method=makers`，`context_meta` 完整落库（est 2530 tokens / budget 190k / max_output_tokens 8000 / finish_reason=stop / changes=1）。
- 预警路径：`MAKERS_INPUT_CHAR_BUDGET=5000` 强制触发，正确输出"输入上下文接近上限"预警文案。
- `vite build` 通过（bundle `assets/index-dnvvJuup.js`）；线上部署 `dpoe58322lll`，protobuddy.20140107.xyz 返回 200。

## 文件变更

- `backend/src/services/makersModels.js`：新增 CONTEXT_LIMITS / OUTPUT_TOKEN_LIMITS / INPUT_CHAR_BUDGET 集中配置与 estimateTokens / isReasoningModelId / repairTruncatedPlanJson 导出；文件上下文构建记录 meta；输入预算守卫；max_tokens 分层提升；输出截断检测与抢救；返回 contextMeta。
- `backend/src/routes/plans.js`：导入集中配置，文件选取上限按模型分层；plan 记录持久化 `context_meta`。
- `frontend/src/pages/PlanReview.jsx`：新增 context_meta 概览/预警横幅。

## 后续事项

1. 120s Cloud Function 硬超时仍是推理模型输入窗口的天花板——默认值已按此权衡，如需更大窗口请用 env 变量按项目调整并观察生成耗时。
2. 本地 3001 后端运行中（正常配置）。
