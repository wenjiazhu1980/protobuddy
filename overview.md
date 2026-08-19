# 任务概览：任务拆解 + GitLab Issues 集成

**提交**: `5840c75` (main) · 13 个文件 · +1918 行 · 2026-08-19

## 功能说明

ProtoBuddy 新增「原型 → 开发任务」闭环：评审完成后，一键把原型拆解为结构化开发任务，并可推送到私有 GitLab 生成 Issue。

### 1. 自动任务拆解（breakdown.js）
- 三种粒度：`page`（按页面）/ `feature`（按功能块）/ `interaction`（按交互点）
- 纯规则引擎解析原型 HTML，零 API 消耗
- 自动产出：P0/P1/P2 优先级、基于 DOM 复杂度的工时估算、关联批注折叠为任务验收点
- 支持 dry-run 预览后再落库

### 2. 任务管理（tasks.js + Tasks/TaskDetail 页面）
- CRUD（写操作走 owner 密码门禁，复用既有 ownerAuth）
- 看板视图（按 todo / in_progress / done 分列）+ 任务详情页
- split / merge：任务可递归拆分与合并，关联批注随任务自动迁移
- 批注双向同步：关联批注全部 resolved → 任务自动置 done；批注 reopen → 任务自动回到 in_progress

### 3. 导出与 GitLab 集成（gitlabIssues.js）
- 导出 JSON / CSV，CSV 兼容 GitLab Issue 导入格式
- REST API v4 直接推送 Issue 到私有 GitLab（gitlab.parsec.com.cn）
- 项目级配置（base_url / private_token / project_id），token 仅存后端、接口读取时掩码
- 连接测试端点，配置错误可即时发现

## 验证情况

- 后端三文件 `node --check` 语法通过
- 前端 `npm run build` 成功（46 模块）
- 本地端到端冒烟全通过：owner 验证 → 拆解预览/生成 → 详情/更新 → split/merge → 批注同步 → 双格式导出 → GitLab 配置保存（token 掩码读取确认）→ 连接测试（坏 token 正确报错）→ 无 token 写操作正确返回 401
- 冒烟产生的测试任务与假 GitLab 配置已从本地 db.json 清理

## 后续事项

1. **未部署线上**：protobuddy-app.edgeone.cool 仍是旧版；部署时注意前端源码变更必须用 `npm run build:local`（root 的 build 不会重编 frontend/dist）
2. 本地 dev 后端仍在 3001 端口运行（已加载新代码），如需释放端口：`kill 20155`
3. 可选迭代：任务与「修改方案」联动（方案 apply 后自动勾掉对应任务）、GitLab 推送失败重试队列
