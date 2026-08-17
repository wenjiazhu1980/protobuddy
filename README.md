# 原型协作评审平台 (ProtoBuddy)

基于 EdgeOne Makers 的原型在线托管与协作评审 Agent 工作台。

## 核心闭环

```
owner 上传静态原型包 → 部署到 EdgeOne Makers（不可达则本地托管兜底）
→ 团队成员在预览中「锚点批注」→ Agent 依据批注生成结构化修改方案
→ owner 审核方案 → 应用修改并自动重新部署 → 新版本预览
```

## 技术栈

- **前端**: React + Vite (端口 5173)
- **后端**: Express + JSON 文件存储 (端口 3001)
- **部署**: EdgeOne Makers CLI（优先） / 本地静态托管（兜底）
- **Agent**: Makers Models API（优先） / 规则引擎（兜底）

## 快速启动

```bash
# 1. 启动后端
cd backend
npm install
npm start          # http://localhost:3001

# 2. 启动前端（开发模式）
cd frontend
npm install
npm run dev        # http://localhost:5173

# 3. 生产模式（单服务器）
cd frontend && npm run build   # 构建到 dist/
cd ../backend && npm start     # 后端自动检测并服务前端
```

## 项目结构

```
backend/
├── src/
│   ├── index.js              # Express 入口
│   ├── db.js                 # JSON 文件存储（projects, files, annotations, plans 等）
│   ├── routes/
│   │   ├── projects.js       # 项目 CRUD + 上传 ZIP
│   │   ├── files.js          # 文件读写 + 静态预览服务
│   │   ├── deploy.js         # EdgeOne CLI 部署 + 本地兜底
│   │   ├── annotations.js    # 锚点批注 CRUD
│   │   └── plans.js          # 方案生成 + 审核 + 应用
│   └── services/
│       ├── fileStorage.js    # ZIP 解压、文件读写、路径解析
│       ├── edgeone.js        # EdgeOne Makers CLI 部署
│       └── makersModels.js   # Makers Models API 代理 + 规则引擎兜底
└── data/                     # 原型文件 + db.json

frontend/
├── src/
│   ├── App.jsx               # 路由配置
│   ├── api.js                # API 客户端
│   ├── styles.css            # 全局样式（蓝灰主题）
│   ├── pages/
│   │   ├── ProjectList.jsx   # 项目列表 / 创建
│   │   ├── Dashboard.jsx     # 仪表盘（文件树、部署状态、重新部署）
│   │   ├── Review.jsx        # 评审页（iframe 预览 + 锚点批注）
│   │   ├── PlanReview.jsx    # 方案审核（逐条通过/驳回）
│   │   └── Settings.jsx      # 密钥配置
│   └── components/
│       ├── PreviewFrame.jsx  # iframe 预览 + 透明覆盖层
│       └── AnnotationLayer.jsx # 批注列表面板
└── vite.config.js            # Vite 配置（含 API 代理）
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects` | 创建项目 |
| POST | `/api/projects/:id/upload` | 上传原型 ZIP |
| POST | `/api/projects/:id/deploy` | 部署（EdgeOne / 本地） |
| GET | `/api/projects/:id/preview/*` | 预览原型（静态托管） |
| GET/POST | `/api/projects/:id/annotations` | 批注增删查 |
| POST | `/api/projects/:id/plan` | 生成修改方案 |
| POST | `/api/projects/plans/:planId/changes/:cid/approve` | 审核通过 |
| POST | `/api/projects/plans/:planId/apply` | 应用修改 + 重新部署 |

## 关键设计

### 跨域 iframe 批注
用与 iframe 等大的透明覆盖层捕获点击坐标（存百分比），不读取 iframe 内部，完全规避跨域限制。

### 三层兜底
1. **EdgeOne 不可达** → 本地静态托管（`/api/projects/:id/preview/`）
2. **Makers Models 不可达** → 规则引擎生成结构化方案
3. **密钥未配置** → 同上兜底，保证 demo 闭环

### 密钥安全
EdgeOne Token 和 Makers Models Key 按项目存储在后端，API 调用全部经后端代理，绝不下发前端。
