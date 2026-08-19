# protobuddy 项目规则

## 项目目标
原型协作评审平台（ProtoBuddy）基于 EdgeOne Makers，提供在线原型托管、协作评审和 Agent 生成修改方案的全栈解决方案。核心闭环为：owner 上传原型 → 部署到 EdgeOne Makers（兜底本地托管）→ 团队成员在预览中添加锚点批注 → Agent 生成结构化修改方案 → owner 审核 → 应用修改并自动重新部署 → 新版本预览。

## 核心原则
- **闭环完整**：所有功能必须能端到端运行，包括部署、批注、方案生成、审核、应用、重新部署。
- **兜底机制**：EdgeOne 不可达时使用本地静态托管；Makers Models 不可达时使用规则引擎生成方案；密钥未配置时同样走兜底。
- **安全优先**：owner 操作（密码验证、文件上传、部署、方案审核/应用）必须受保护；密钥绝不在前端下发。
- **性能与稳定性**：部署优先 EdgeOne Makers CLI，超时处理严格；方案生成限制大项目文件数量。
- **用户友好**：设置页配置密钥；前端展示数据源（平台存储 vs 最新部署）；方案展示一致性评分和预检结果。
- **可扩展**：支持自定义域名（overseas/global）；支持生成器脚本（Python）自动重新生成 HTML。

## 技术栈
- **前端**：React + Vite（端口 5173），核心组件包括 PreviewFrame（iframe + 透明覆盖层实现锚点批注）、AnnotationLayer（批注面板，可收起/展开）。
- **后端**：Express（端口 3001），routes 包括 projects.js、files.js、deploy.js、annotations.js、plans.js、ownerAuth.js；services 包括 fileStorage.js、edgeone.js、makersApi.js、makersModels.js、generator.js、consistency.js、ownerAuth.js。
- **存储**：JSON 文件存储（data/projects/） + 可选 Blob 存储（EdgeOne Makers Cloud Functions）。
- **Agent**：Makers Models API（优先，deepseek-v4 等模型） + 本地规则引擎兜底（consistency.js、dry-run 预检、scorecard 评分）。
- **部署**：EdgeOne Makers CLI（npx edgeone makers deploy）或本地静态托管；支持 regenerate.js 外部执行 Python 生成器。

## 关键文件与职责
- **backend/src/db.js**：存储驱动分发（blob/local）。
- **backend/src/routes/deploy.js**：部署端点（EdgeOne + 兜底本地）、deploy-status、domains、preview-url。
- **backend/src/services/makersApi.js**：Makers API 客户端（callApi、getOrCreateProject、uploadAndDeploy、pollDeployment、getProjectUrl、describeProjectDomains）。
- **backend/src/services/edgeone.js**：EdgeOne CLI 部署 + 本地兜底。
- **backend/src/services/makersModels.js**：Makers Models 代理 + 规则引擎兜底（systemPrompt 含 GENERATOR-SCRIPT、GENERATOR DUAL-WRITE 等规则）。
- **backend/src/services/generator.js**：prepareForDeploy（检测生成器脚本、needsExternal、regenerateRequired）。
- **frontend/src/components/PreviewFrame.jsx**：iframe 预览 + 透明覆盖层 + 锚定/滚动同步。
- **frontend/src/components/AnnotationLayer.jsx**：批注面板（收起/展开、列表）。
- **frontend/src/pages/Review.jsx**：评审页（数据源徽章、最新部署外链、批注列表）。
- **frontend/src/pages/PlanReview.jsx**：方案审核页（评分卡、预检徽章、一致性横幅、回滚按钮）。

## 开发与部署规范
- **本地开发**：cd backend && npm install && npm start；cd frontend && npm install && npm run dev；Vite 代理 /api。
- **生产模式**：cd frontend && npm run build；cd backend && npm start（单服务器）。
- **线上部署**：npx edgeone makers build --mode prod && npx edgeone makers deploy . -n protobuddy-app -t <token> -e production --json -a global（或 overseas）。
- **Git 工作流**：拉取最新代码（git pull origin main）；使用 git worktree 隔离特性分支；PR 必须通过严格代码审查（代码质量审计：不让文件 >1k 行、不让 spaghetti 增长、主动寻找 code judo 简化）。
- **数据库**：data/projects/<id>/ 目录结构；JSON 表（projects/files/annotations/plans/planChanges/deployments）。
- **密钥管理**：设置页填写 EdgeOne Token / Makers Key；按项目存 TCB 或本地；owner 操作必须密码验证（OWNER_PASSWORD）。

## 规则引擎（Makers Models 兜底）
- systemPrompt 固定包含：批注收集、old_code 唯一匹配检查、consistency 评分（0.4 权重）、dry-run 预检、scorecard（0-100 评分）、dual-write 规则。
- 生成方案时自动执行 consistency.js 检查 + 预检；apply 时检查 old_code 唯一性；失败时返回 409 + 具体 errors。

## 待办
- [ ] 配置 EdgeOne Token / Makers Key
- [ ] 自定义域名绑定（protobuddy.20140107.xyz）
- [ ] 优化 blob 存储清理（旧 demo 文件）
- [ ] 前端构建产物部署（包含最新 UI 改动）

此文件用于 Claude / Grok 开发会话上下文，确保一致性。建议软链接到 agents.md 以便全局引用。