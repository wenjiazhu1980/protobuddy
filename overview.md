# 原型协作评审平台 - 完成概要

## 已完成

构建了完整的「原型在线托管与协作评审 Agent 工作台」，核心闭环全部跑通：

**owner 上传原型 → 部署 → 锚点批注 → Agent 生成方案 → 审核应用 → 自动重新部署**

### 技术实现
- **后端 (Express, 端口 3001)**: 项目CRUD、ZIP上传解压、文件读写、EdgeOne CLI部署（本地兜底）、批注管理、方案生成（Makers Models + 规则引擎兜底）、方案审核与应用
- **前端 (React+Vite, 端口 5173)**: 5个页面（项目列表/仪表盘/评审/方案审核/设置）+ 2个核心组件（PreviewFrame iframe预览/AnnotationLayer 锚点批注）
- **数据存储**: JSON文件存储（projects/files/annotations/plans/planChanges/deployments）
- **跨域方案**: 透明覆盖层捕获点击坐标（百分比），不读iframe内部

### 验证通过的完整流程
1. ✅ 创建项目（支持填写EdgeOne Token / Makers Key）
2. ✅ 上传原型ZIP包（自动解压、文件入库）
3. ✅ 一键部署（EdgeOne CLI优先，本地静态托管兜底）
4. ✅ iframe预览原型（通过透明覆盖层实现锚点批注）
5. ✅ 团队成员免登录添加锚点批注（坐标存百分比）
6. ✅ Agent生成结构化修改方案（Makers Models优先，规则引擎兜底）
7. ✅ Owner逐条审核方案（通过/驳回）
8. ✅ 应用已批准修改（修改文件 + 解决批注 + 自动重新部署）

### 三层兜底保障
1. EdgeOne不可达 → 本地静态托管
2. Makers Models不可达 → 规则引擎生成方案
3. 密钥未配置 → 全部使用兜底方案，demo闭环完整可用

## 关键文件
- `backend/src/index.js` - Express入口
- `backend/src/db.js` - JSON文件存储
- `backend/src/services/edgeone.js` - EdgeOne CLI部署 + 兜底
- `backend/src/services/makersModels.js` - Makers Models代理 + 规则引擎兜底
- `backend/src/services/fileStorage.js` - 文件存储（ZIP解压、路径解析）
- `frontend/src/pages/Review.jsx` - 评审页（iframe + 锚点批注核心）
- `frontend/src/components/PreviewFrame.jsx` - 透明覆盖层实现
- `frontend/src/components/AnnotationLayer.jsx` - 批注面板

## 运行方式
- 开发模式: 后端(3001) + 前端dev(5173)，Vite代理API
- 生产模式: `cd frontend && npm run build` → `cd backend && npm start`（单服务器）

## 待用户配置（可选）
- EdgeOne Makers API Token（部署到EdgeOne，否则本地托管）
- Makers Models API Key（Agent调用大模型，否则规则引擎兜底）
- 均可在「设置」页按项目填写
