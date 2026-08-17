# 原型协作评审平台（基于 EdgeOne Makers）

## 目标
构建一个原型在线托管与协作评审平台，闭环如下：
owner 上传静态原型包 → 一键部署到 EdgeOne Makers（不可达则应用内托管兜底）→
团队成员在预览中「锚点批注」→ Agent（Makers 内置模型）依据批注生成结构化修改方案 →
owner 审核方案 → 应用修改并自动重新部署 → 新版本预览。

## 技术栈
- 前端：React + Vite（Genie web 模板）。iframe 预览 + 透明覆盖层实现锚点批注。
- 后端：Express (Node)。承担三类服务端能力：① 原型文件存储与读写 ② 调用 `edgeone` CLI 部署 ③ 代理 Makers Models（密钥不下发前端）。
- 存储：TCB 托管 PostgreSQL（经 `genie-tcb-db-integrator` 建表），由后端统一读写；原型静态文件存后端文件系统（部署 CLI 需要本地目录）。
- 密钥：owner 在「设置」页填写 `EDGEONE_API_TOKEN` 与 `MAKERS_MODELS_KEY`，按项目存 TCB，后端代理调用。

## 数据模型（TCB Postgres）
- `projects`: id, slug, name, edgeone_project_name, edgeone_token(密), makers_key(密), current_url, status, created_at
- `files`: id, project_id, path, content, version, updated_at
- `deployments`: id, project_id, version, url, env, status, created_at
- `annotations`: id, project_id, version, x, y(百分比), page, author, content, status(open/resolved), created_at
- `plans`: id, project_id, annotations(jsonb), status(draft/approved/rejected), created_at
- `plan_changes`: id, plan_id, file_path, description, old_code, new_code, status(pending/approved/applied/rejected)

## 后端 API（Express，/api）
- `POST /api/projects` 创建项目（含 token/key）
- `POST /api/projects/:id/upload` 接收 ZIP，解压到 `backend/data/projects/:id/`，文件内容入库
- `GET /api/projects/:id/files` 列文件 / 读文件内容
- `POST /api/projects/:id/files` 写回修改后的文件
- `POST /api/projects/:id/deploy` 调 `npx edgeone makers deploy`；失败回退到本地静态托管，返回 preview URL
- `GET /api/projects/:id/preview/*` 静态托管原型（兜底预览 + iframe 源）
- `GET|POST /api/projects/:id/annotations` 批注增删查
- `POST /api/projects/:id/plan` 收集 open 批注 + 当前文件 → 调 Makers Models(`@makers/hy3`) 生成结构化方案 → 存 plans/plan_changes
- `POST /api/plans/:id/changes/:cid/approve|reject`
- `POST /api/plans/:id/apply` 将 approved 修改写入文件 → 触发重新部署 → 新版本

## 前端页面
- `/` 项目列表 / 创建
- `/project/:id` 仪表盘：文件树、部署状态、preview URL、重新部署按钮
- `/project/:id/review` 预览 + 锚点批注（团队成员入口，无需登录）
- `/project/:id/plan` Agent 生成的修改方案审核（逐条通过/驳回）
- 设置：填写 EdgeOne token / Makers key

## 关键风险与兜底
- 跨域 iframe 批注：用与 iframe 等大的透明覆盖层捕获点击坐标（存百分比），不读取 iframe 内部，规避跨域限制。
- EdgeOne CLI 不可达/无网络：后端先尝试 `npx edgeone makers deploy`（带超时），失败则用本地静态托管 URL 作为预览链接（应用内托管兜底），保证评审闭环可用。
- Makers Models 不可达/无 key：回退到基于批注的规则化方案摘要，保证 demo 闭环。
- 密钥安全：按项目存 TCB，后端代理调用，绝不下发前端；MVP 阶段明文存库并注明生产需加密。

## 设计风格（简洁专业 · 蓝灰）
- 主色 `#2563eb`，背景 `#f1f5f9`，卡片化布局；批注 pin 用强调橙 `#f97316`；方案变更用状态色（待审/通过/驳回）。
- 布局：左侧项目/文件导航，中部 iframe 预览为主，右侧浮层为批注列表与方案面板。

## 待 owner 在应用内提供（无需预先交给我）
- EdgeOne Makers API Token（部署用）
- Makers Models API Key（Agent 用）
均可在「设置」页填写。

## 主要新增/修改文件
- `backend/src/routes/projects.js`、`deploy.js`、`annotations.js`、`agent.js`、`files.js`
- `backend/src/services/edgeone.js`（CLI 部署 + 兜底）、`backend/src/services/makersModels.js`（OpenAI 兼容代理）
- `backend/src/db.js`（TCB 连接，由 skill 提供 env）
- `frontend/src/pages/*`、`frontend/src/components/PreviewFrame.tsx`、`AnnotationLayer.tsx`、`PlanReview.tsx`、`Settings.tsx`
- `.env.example`、TCB 建表脚本（经 `genie-tcb-db-integrator`）