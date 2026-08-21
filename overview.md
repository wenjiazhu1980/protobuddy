# 前端改版 + Tab 导航丢失修复

## 任务一：前端全面改版 — Figma 风格黑白灰 UI

## 任务概述
对 ProtoBuddy 前端进行整体改版：响应式三档适配（桌面/平板/移动端）、流畅交互动效、Figma 风格简洁现代的黑白灰视觉体系。纯 CSS 令牌化实现，零新增依赖。

## 五个阶段（全部完成，git ddc36f1）

### Phase 1 — 设计令牌 + 全局换肤
- `styles.css` `:root` 重写：zinc 中性色阶、字号/间距/圆角/阴影/动效时长与缓动令牌（--dur/--ease-out/--ease-spring 等）
- `--primary` 三值改黑色（#18181b），修复未定义的 --radius-md/--purple/--blue 引用 bug
- 同步换色：favicon、TopBar logo、PreviewFrame 批注 pin 三色、链接色、Tasks/Dashboard 散落硬编码

### Phase 2 — 导航改版
- 新增 `projectTabs.js` + `ProjectNav.jsx`：项目内 5 Tab（概览/评审/方案/任务/设置），sticky + active 指示条
- App.jsx TopBar 改造：<768px 汉堡菜单 + 面包屑；删除 Dashboard/Review 页内旧导航按钮
- `dashboard-layout` 高度公式走令牌

### Phase 3 — 公共层 + 内联样式迁移
- 新增 `ToastContext.jsx`（全局 toast 栈、退场动画、info 白底）+ `EmptyState.jsx`
- 6 个页面本地 toast 全部迁移到 `useToast()`；页头/页标题/返回链接/弱化文本迁移到 `.page-header`/`.page-title`/`.back-link`/`.text-sm-muted` 公共类

### Phase 4 — 响应式三档
- 统一断点 1024/768/480：dashboard 侧栏收窄→单列、review 双栏→单列、task-board 3列→1列、modal/toast 全宽、页头可换行
- Review 动态列宽改 CSS 变量桥接（`--review-cols`），媒体查询可正常覆盖内联值

### Phase 5 — 动效体系
- 页面切换 pageEnter、卡片 hover 微抬升、按钮 press scale(0.97)、Modal overlayIn/modalIn 弹性进场、project-card hover 抬升
- `prefers-reduced-motion` 兜底关闭非必要动效（spinner 保留）

## 红线守护（批注锚点未受影响）
- `.preview-iframe-wrapper` position:relative 语义未动
- `.annotation-pin` left/top/transform 几何属性仍由 inline getPinStyle 注入，CSS 无覆盖
- 批注状态色（resolved/rejected）已令牌化但色值语义不变

## 验证与部署
- 前端构建通过（CSS 27.76 kB gzip 5.83 kB）
- 已部署：deployment `dp8wtmca7aag` → https://protobuddy.20140107.xyz（home 200，线上 CSS 已含 pageEnter/overlayIn/--review-cols/prefers-reduced-motion）
- 代码已推送：git `ddc36f1`

## 任务二：修复项目内 Tab 导航丢失（git d74af27）

**问题**：改版后 Dashboard/Review/Plan/Tasks/Settings 页面均不显示「概览/评审/方案/任务/设置」Tab 栏，方案审核、任务清单等功能入口全部丢失。

**根因**（React Router v6 陷阱）：
- App.jsx 将 `<ProjectNav />` 放在 `<Routes>` 闭合标签**之外**，组件内 `useParams()` 拿不到 `:id` → 返回 undefined → `if (!projectId) return null` 整块不渲染
- 这是 React Router v6 的常见坑：`useParams` 只在 `<Routes>` 匹配上下文内可用，挂载在 Routes 外的组件拿不到参数

**修复**：
- App.jsx：`location.pathname.startsWith('/project/')` 判断 inProject，`split('/')[2]` 提取 projectId 以 prop 传入 `<ProjectNav projectId={...} />`
- ProjectNav.jsx：改为接收 `{ projectId }` prop，不再依赖 useParams（import 同步移除）
- TopBar 汉堡菜单项目 id 同样改为 split 解析，全局移除 matchPath 依赖

**验证**：
- 本地 Playwright 5 页面（dashboard/review/plan/tasks/settings）nav 全部渲染，含项目名 + 5 Tab
- 线上 https://protobuddy.20140107.xyz 验证：3 页面 nav count=1，文本「优美丝路二期 | 概览 | 评审 | 方案 | 任务 | 设置」
- 部署：deployment `dp0qsyt1scwc`

## 任务三：方案生成提示词增强 — SMART EDIT 智能修改方法论（git 699d83d）

**需求**：方案生成 Agent 应做「精准修改」而非机械字符串替换，防止替换引入逻辑冲突、重复代码、遗漏关联项。

**实现**（`backend/src/services/makersModels.js`，+7/-2）：
- systemPrompt Rules 首部新增**最高优先级** `SMART EDIT methodology` 区块，4 步：
  1. **LOCATE 定位问题** — 先审查目标代码根因，分析简单替换可能引入的错误类型（逻辑冲突/重复代码/遗漏关联项）
  2. **REASON 智能修改** — 基于文件上下文做结构性和逻辑性修改，new_code 与整体设计一致；禁止「加 TODO 注释」式敷衍改动
  3. **AVOID 错误规避** — 自查变量/函数引用一致性、样式或组件命名冲突、依赖关系断裂
  4. **VERIFY 验证结果** — old_code 唯一匹配、new_code 自洽（标签闭合/括号配对），description 末尾注明「关键点/注意」
- 预检失败重试反馈（feedbackBlock）同步要求按 SMART EDIT 四步重做
- 与现有 old_code/new_code 契约、precheck/apply 机制完全兼容，零前端改动

**验证**：`node --check` 通过；构建快照含 8 处 SMART EDIT 匹配；线上 health 200 + 前端 200
**部署**：`dplloznbn6zf` → https://protobuddy.20140107.xyz

## 后续可选
- PlanReview/Tasks/Dashboard 剩余低频内联样式可继续渐进迁移
- 可选：骨架屏替代整页 spinner、路由级代码分割
