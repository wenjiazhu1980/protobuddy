# 任务概览：Agent 上下文二次扩容 + 关键文件保护

**提交**: main · 2 个文件改动 · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dptkkoie1fgz）

## 背景

线上项目生成方案 #498（deepseek/deepseek-chat）时，输入 187409/190000 字符几乎打满，仅 9/14 个文件就耗尽预算，同模块 5 个 merchant 页面被省略，生成器脚本 `_gen_pages.py` 仅摘录 → 匹配质量 50、预检未通过。本次在「上下文限制集中化 + 截断预警」基础上继续扩容，并优化文件选择策略，避免关键文件被挤出。

## 本次改动

### 1. 继续扩容输入/输出窗口（makersModels.js）

- **非推理模型**（deepseek-chat / @makers/hy3）：
  - 整 prompt 字符预算 190000 → **350000**
  - 最大文件数 14 → **24**
  - 单文件上限 50000 → **90000**
  - 小文件全显阈值 24000 → **48000**
  - 输出 token 上限 8000 → **12000**
- **推理模型**（deepseek-v4 / kimi-k2 / minimax）小幅提升：
  - 整 prompt 字符预算 110000 → **160000**
  - 最大文件数 8 → **10**
  - 单文件上限 20000 → **30000**
  - 小文件全显阈值 8000 → **12000**
- 所有参数仍支持环境变量覆盖，无需改代码即可按项目/环境调整。

### 2. 关键文件优先保护

- **生成器脚本优先全显**：对 `_gen*.py` / `generate*.py` / `build.py` / `make*.py` 等 Python 生成器脚本，将小文件判定阈值提升到单文件上限，尽量完整送入上下文，避免仅摘录导致 `old_code` 不精确。
- **跨文件关键词 hint**：从批注内容自动提取 CJK 4+ 字符词与英文标识符，作为 excerpt 搜索关键词， surfaced 同模块/共享组件文件中的相关片段。
- **plans.js 排序优化**：文件选择时，与目标页面**同目录**的文件优先级仅次于目标页面本身（100），高于生成器脚本（300），远高于无关页面（999）。
- **预算守卫智能丢弃**：不再简单从尾部 pop，而是按重要性丢弃——目标页面（1000） > 生成器脚本（800） > 同目录文件（500） > 其他 `.py`（400） > 无关文件（0）。

### 3. 保留的截断预警机制

- 输入侧：超预算 85% 黄色预警，列出被省略/摘录的文件。
- 输出侧：`finish_reason=length` 时抢救完整 change 对象并标记 `output_truncated`；输出用量 ≥ 85% 上限预警。
- 前端 PlanReview.jsx 继续展示 context_meta 概览/预警横幅。

## 验证情况

- `node --check` 通过（makersModels.js / plans.js）。
- `vite build` 通过（bundle `assets/index-dnvvJuup.js`）。
- 单测：新限制值正确、截断抢救函数仍能从 3 条切尾中救回 2 条。
- 本地 E2E（项目 1，deepseek-chat）：生成 plan #10084，`budget=350000`、`max_output_tokens=12000`、`finish_reason=stop`。
- 线上部署成功：`dptkkoie1fgz`，`protobuddy.20140107.xyz` 返回 200。

## 文件变更

- `backend/src/services/makersModels.js`：扩容 CONTEXT_LIMITS / OUTPUT_TOKEN_LIMITS / INPUT_CHAR_BUDGET；新增生成器脚本判定与全显策略；批注关键词提取；预算守卫按重要性丢弃。
- `backend/src/routes/plans.js`：rank 函数增加同目录文件高优先级。

## 后续事项

1. **120s Cloud Function 硬超时仍是天花板**。350k 字符对非推理模型 deepseek-chat 仍处于安全区，但继续扩容需监控生成耗时；若仍不足，下一步应改走「按批注分批生成」或「只读相关函数/模板片段」，而非继续堆字符。
2. 如需临时调参，优先使用环境变量（如 `MAKERS_INPUT_CHAR_BUDGET=500000`），无需重新部署代码。
