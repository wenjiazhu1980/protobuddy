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
- `backend/src/db.js` - 存储驱动分发（blob/local 懒加载）
- `backend/src/dbBlob.js` - Blob 存储驱动（EdgeOne Makers 线上模式）
- `backend/src/services/edgeone.js` - EdgeOne CLI部署 + 兜底
- `backend/src/services/makersModels.js` - Makers Models代理 + 规则引擎兜底
- `backend/src/services/fileStorage.js` - 文件存储（ZIP解压、路径解析）
- `backend/src/services/ownerAuth.js` - owner 操作密码验证（HMAC token + 失败锁定）
- `cloud-functions/api/[[default]].js` - EdgeOne Makers 框架函数入口
- `frontend/src/pages/Review.jsx` - 评审页（iframe + 锚点批注核心）
- `frontend/src/components/PreviewFrame.jsx` - 透明覆盖层实现 + 元素锚定/滚动同步
- `frontend/src/components/AnnotationLayer.jsx` - 批注面板
- `frontend/src/components/OwnerAuthDialog.jsx` / `OwnerAuthContext.jsx` - owner 密码弹窗与会话验证

## 上线部署（EdgeOne Makers 全栈，2026-08-17）
- **线上地址**: `https://protobuddy-app.edgeone.cool`（主用，当前部署 dpt9pkpdbxzp）
- Cloud Functions（Express 框架函数，/api/*）+ Blob 存储 + 静态前端同一项目
- 部署命令: `npx edgeone makers build --mode prod` → `npx edgeone makers deploy . -n protobuddy-app -t <token> -e production --json -a global`
- 完整流程与避坑见 skill: `~/.workbuddy/skills/edgeone-makers-deploy/SKILL.md`

## 迭代 14-17 关键能力
- **迭代 14**: 批注后不再自动生成方案，改为手动触发「生成修改方案」
- **迭代 15**: 批注锚点升级为**元素级**（点击元素探测 __protoProbe，记录 tagName/id/path/text 等）；应用修改时 old_code 唯一性检查，防止误改多处
- **迭代 16**: 批注标记**随页面滚动实时同步**（__protoQuery 按 id/path/text 查询元素当前位置，throttle+rAF 批量更新，滚出视口自动隐藏）
- **迭代 17**: **owner 操作密码验证**——受保护操作（项目维护/文件上传/部署/方案审核/方案应用）需密码（默认 gugugaga2026，OWNER_PASSWORD 可配置）；会话内一次验证（HMAC token 8h）；连续失败 5 次锁定 5 分钟；仅 owner 角色生效。线上端到端验证全部通过
- **迭代 18**: **修复 Kimi K2.6 调用 400**——推理模型（@makers/kimi-k2.6，内置免费）拒绝 temperature 参数（moonshot 400001），已按模型适配（不传 temperature、max_tokens 8000、超时 120s）；同时修复大项目生成方案 504（只读批注相关文件 ≤10 个，不再全量读 56 个文件）。设置页可选 7 种内置模型，Kimi K2.6 已线上验证
- **迭代 19**: **7 个内置模型全部兼容**——实测仅 kimi-k2.6 拒绝 temperature；minimax-m3 会把 `<think>` 思维链混入 content 污染 JSON，已在解析层剥离 `<think>/<reasoning>` 标签兜底；推理模型识别扩为 deepseek-v4/minimax（max_tokens 8000、超时 120s）。设置页下拉标注快慢/质量便于选择。线上实测 deepseek-v4-pro（66.9s 质量高）、minimax-m3（14.5s）均正常；推荐 deepseek-v4-flash（快+均衡）

## 迭代 20：排查「应用修改方案持续失败」——agent 未参与修改 + 两处真实 bug 修复
- **排查结论（用户 4 点）**：
  1. **agent 未执行修改**：`POST /plans/:planId/apply` 只做 `content.replace(old_code, new_code)` 机械替换，agent（Makers Models）仅在「生成方案」阶段调用，应用阶段无 agent 参与——方案不精确即失败；
  2. **路径/参数/权限**：发现真 bug——`edgeone.js` local 分支 `getProjectDir()/findEntryPoint()` 是 async wrap 但未 await → `path.join(Promise)` 抛 `The "path" argument must be of type string` → **本地每次 apply 后 redeploy 必失败**（本地复现确认）；
  3. **返回值**：apply 无论成败都返回 HTTP 200；`success:false` 只在 body；且**无条件 `plan.status='applied'` + resolve 批注** → 失败被永久化、无法重试；
  4. **异常静默**：`makersModels.js` API 失败静默降级规则引擎（success:true，只有小黄条提示）；规则引擎 old_code 是「位置切片」几乎必不匹配 → apply 失败主因；dbLocal save() 写盘失败静默吞。
- **修复**：
  - edgeone.js 补 `await`（Bug B，本地 redeploy 恢复）；
  - plans.js apply 语义重写：失败 change 回退 approved、plan 回退 approved、不 resolve 批注、返回 **HTTP 409 + 具体 errors**；检查 writeFileContent 返回值；仅成功时才标 applied；deploy 失败独立报 deployError（200 + success:false）；
  - 前端 PlanReview：失败留在本页并展示具体错误、可重试；api.js 透传 err.errors/deployError。
- **本地端到端验证**：失败路径 409 + plan 从误标 applied 回退 approved ✓；成功路径 200 + 文件改动 + redeploy 正常（不再 Promise 报错）✓；测试副作用（本地文件文案 + shop-demo 线上部署）已还原并重新部署 ✓。
- 构建产物 `.edgeone/cloud-functions/api-node/index.mjs` 已确认含两处修复（allChangesApplied/failedChanges/deployError + await getProjectDir）。**线上部署待凭据**（当前 edgeone-pages connector 未连接，本机无平台 token）。

## 迭代 21：评审预览与 EdgeOne 部署数据源不一致（2026-08-18）
- **现象**：`https://protobuddy-app.edgeone.cool/api/projects/1/preview/`（评审预览）显示的不是最新 EdgeOne Makers 部署，而是「平台存储」里的旧文件。
- **根因**：评审预览 iframe 永远加载 `/api/projects/:id/preview/`（`PreviewFrame.jsx` 第 61 行），该路由从**平台存储**（线上=Blob / 本地=fs，`files.js` 的 `servePreview` → `readFileContent`）读文件；而 EdgeOne 部署（`edgeone.js`）也是从 Blob 读文件外发（`collectCloudFiles`）——**两边本应同源**。脱节发生在「部署不是从 Blob 来的」：项目 1 的最新部署是**本地 CLI 推送的**（`data/projects/1/test-prototype/.edgeone/project.json` → `shop-demo`，`makers-be6pk5nfw6np`），线上 Blob 里项目 1 仍是旧 demo 文件 → 评审预览读 Blob = 旧版。
- **修复**：
  1. **UI 明示数据源**（本次已改）：Review 页工具栏新增「平台存储 v{version}」徽章 + 部署成功时「最新部署 ↗」外链按钮（新窗口打开 EdgeOne 部署）；`deploy_failed` 状态显示红色「部署失败」徽章。CSS 新增 `.preview-sync-hint` 预留提示条。
  2. **数据同步（待线上授权）**：需用户提供 protobuddy-app 带 eo_token 的预览链接 → 用 `/api/projects/1/files` 将本地最新文件上传覆盖 Blob → 重新部署。
  3. **流程约定**：所有文件变更一律走平台（上传/apply 写 Blob），EdgeOne 部署永远从 Blob 外发，评审预览恒等于最新部署。
- **待办**：线上 Blob 数据同步（需授权链接）+ 前端构建产物（含本次 UI 改动）部署线上。

## 迭代 21 完成：评审预览与 EdgeOne 部署已同源一致（2026-08-18 上午）
- 用户提供 `protobuddy-app.edgeone.cool?eo_token=...` 授权链接 → 两步 cookie 法访问线上 API。
- **同步**：owner 密码验证 → `POST /api/projects/1/files` 将本地最新 `test-prototype/index.html` 覆盖到 blob 入口 `原型设计/index.html`（version 2→3，未删除旧文件）→ 评审预览立即显示最新。
- **重新部署**：`POST /api/projects/1/deploy` → **deployment #197 / version 20 / success / Deployed 56 files** → `shop-demo.edgeone.dev` 两步 cookie 验证与评审预览内容完全一致（title 测试原型-电商首页 / h1 ShopDemo / h2 秋季新品上市）。
- **残留**：blob 仍保留 55 个旧 demo 文件（仅入口已换新）；如需纯净产物，可在平台重新上传只含最新原型的 ZIP。
- **待办**：前端构建产物（Review 页数据源徽章 + 最新部署外链）部署线上，需平台 token。

## 迭代 21 部署完成：protobuddy-app 全量上线 + 新原型部署（2026-08-18 上午）
- 用户提供平台 API Token（`oGARc1Fv...=` base64 密钥格式）→ 重建产物（前端重新 build，`index-CJ2WBaSv.js` 含 Review 页「平台存储」徽章）+ `npx edgeone makers deploy . -n protobuddy-app -t <token> -e production --json -a global` → **deployment `dp2mjapgp8kp`（61s）成功**。
- 线上验证：health 200、项目列表正常、首页 200 且引用新 JS（`index-CJ2WBaSv.js` 含「平台存储/最新部署」徽章代码）✓——**迭代 20（apply 409 语义 + edgeone await 修复）与迭代 21（UI 明示数据源）全部上线**。
- 发现线上 Blob 项目 1 已被用户替换为 **CIS 阶段二原型（41 个 `phase-2/` 文件，入口 `phase-2/index.html`，title「CIS 阶段二原型入口」）**，但最新部署仍停在 v20 旧电商原型 → 触发 `POST /api/projects/1/deploy` → **deployment #240 / version 23 / success / Deployed 41 files** → `shop-demo.edgeone.dev` 两步 cookie 验证 = 评审预览完全一致（CIS 阶段二原型入口 / 阶段二 · 履约闭环原型）✓。
- 至此「评审预览 = 最新部署」闭环达成；旧 56 文件 demo 已被用户重新上传覆盖清空（blob 现仅 41 个 phase-2 文件，无残留）。

## 线上验证要点（排查踩坑）
- curl 验证 body 必须用「纯 cookie 两步法」（先 GET 换 cookie，POST 不带 eo_token）；`-L` 在 302 后丢 POST body 会误判平台不解析
- dbBlob.js 的 insert 勿调 nextId()（其内部 reload 会覆盖新表）；已内联 id 生成
- 部署前必须先 `npx edgeone makers build --mode prod`（否则可能复用旧 cloud function 快照）

## 迭代 22 完成：方案 A 生成器外部执行环境（commit 70181d2，本地验证全过）
- **问题**：方案应用后 agent 改 Python 生成器脚本（`_gen_pages.py`），apply 正确写入 blob、部署正常执行，但缺「执行生成器重新生成 HTML」环节 → 部署的仍是旧 HTML。
- **方案（双模式）**：部署/apply 前统一走 `prepareForDeploy`：
  - local 模式：后端直接 `exec python3`（cwd=脚本目录，120s 超时）自动重新生成 → 完整闭环；
  - blob 模式（线上 Cloud Function 只读 FS 无法 exec Python）：响应 `regenerateRequired:true + generator + hint`，由本地 CLI `npm run regenerate -- --project <id> --api <baseURL> --password <pw>` 完成「owner 验证 → 拉取（优先 storage-files）→ python3 执行 → SHA1 快照 diff → 回写 → 触发部署」。
- **生成器检测**：`_gen*.py`/`generate*.py`/`build.py`/`make*.py`，entry 目录内优先、短路径优先；`?force=1` 跳过检查（产物已最新时）。
- **新增端点**：`GET /:id/storage-files`（存储驱动权威文件列表——files 表不完整，项目 30 表空、项目 1 表 1 条但 blob 41 条）。
- **前端**：Dashboard/PlanReview 展示 regenerate 提示条 + 复制命令按钮 + 「仍要部署现有产物」（force）按钮，不误报部署成功。
- **本地验证 5 条路径全过**：① 部署自动检测执行生成器（index.html 重新生成）；② 改配置重部署产物随配置更新；③ CLI 全链路；④ apply 后自动重生成并部署；⑤ force 跳过 + 生成器执行失败返回 409。
- **线上验证（2026-08-18，commit 70181d2 + a5b316a + 2cf77a3）**：部署 protobuddy-app 5 次全成功（最新 deployment `dpm3i8q2b3sn`，前端 `index-CSuTloga.js`）。blob 模式两条分支实测通过：普通 deploy → `regenerateRequired:true + generator:phase-2/_gen_pages.py` 不误部署；`?force=1` → 正常部署。修复 hint 域名坑：EdgeOne 重写 `host` 为内部 SCF host、无 x-forwarded-* 头，公共域名在 **`eo-pages-host`** 头（临时 `_debug/headers` 端点实测后已移除）。**CLI 完整链路线上实测通过**（用户确认后）：握手 → owner 验证 → 拉取 41 文件 → 执行生成器（重写 22 个 HTML）→ diff 回写 2 文件 → 自动 force 部署 v26 → shop-demo 验证内容一致 ✓。CLI 修复 4 个 bug：平台授权握手（manual redirect 拿 302 cookie）、URL 拼接打错路径、生成后部署死循环（自动 force）、前端命令带 eo_token（location.search）。
- **方案 A 全链路闭环达成**：local 模式（后端自动执行）+ blob 模式信号（regenerateRequired）+ blob 模式外部执行（CLI）三条路径全部线上/本地验证完毕。

## 迭代 22.1 完成：plan 249 apply 409 排查与修复（v27）
- **现象**：`POST /api/projects/plans/249/apply` → 409 "old_code 在 phase-2/_gen_pages.py 中匹配 2 次"。唯一性保护（`content.split(old_code).length-1 > 1` 即拒绝）工作正常。
- **根因**：plan 242 曾把「gen-note 备注」插入新建的 `index_page_html()` 函数，但该函数**从未被 `main()` 调用（死代码）**——线上 index.html 实际由 `render_index()` 生成、无备注 → 评审重复批注 3 次（242/245/249）；change 的 old_code（PROTOTYPE 徽章块）在死函数与活函数中同时出现 → 匹配 2 次被拒。
- **修复（方案 A 直接改生成器）**：删死代码 `index_page_html()`（-2349 chars）+ 在 `render_index()` 加 `.gen-note`（CSS 与 HTML；f-string 内花括号 `{{ }}` 转义）→ py_compile 通过 → 上传线上存储 → CLI regenerate（重写 22 页，仅 index.html 变化）→ 自动 force 部署 **v27**（shop-demo.edgeone.dev）→ 线上 index.html 含备注 ✓。
- **收尾**：reject plan 245/249 + change 246/250（避免再 apply 插入重复备注），annotation 241 → resolved。

## 迭代 22.2 完成：生成器防歧义规则入 systemPrompt（deployment dpp1fc7bel40）
- 将 plan 249 教训固化为 `makersModels.js` systemPrompt 的「GENERATOR-SCRIPT precision rule」：① 生成器文件 old_code 必须带唯一函数锚点、扩展至恰匹配 1 次；② 必须改 main() 实际调用、输出直达目标文件的函数（如 render_index()），禁止改死函数；③ description 注明改后需重新生成 HTML。
- 构建 + 部署 protobuddy-app 成功，/api/health 200；新规则对后续 AI 生成的方案立即生效。

## 运行方式
- 开发模式: 后端(3001) + 前端dev(5173)，Vite代理API
- 生产模式: `cd frontend && npm run build` → `cd backend && npm start`（单服务器）
- 线上: 见「上线部署」

## 待用户配置（可选）
- EdgeOne Makers API Token（部署到EdgeOne，否则本地托管）
- Makers Models API Key（Agent调用大模型，否则规则引擎兜底）
- 均可在「设置」页按项目填写

## 迭代 23：新项目 protobuddy（overseas）部署 + 自定义域名接入
- 用户需求：部署到新 EdgeOne Makers 项目 + 自定义域名 protobuddy.20140107.xyz。
- 关键决策：**overseas 区域**（全球可用区·不含中国大陆）——CLI `-a global` 含大陆须备案，域名无备案；overseas 无需备案。实测 global 直连 401 vs overseas 直连 200。
- 已完成：新项目 protobuddy（makers-wfiun1slfauu，overseas，部署 dpdiwt4yrd4n）健康验证全过；DeletePagesProject API 可用（已清理误建的 global 空项目）。
- 待用户：控制台添加自定义域名 → 弹窗取 TXT/CNAME → Cloudflare 加记录 → 自动签 SSL。CLI/API 无域名绑定 Action，只能控制台。
- 后续部署命令需带 `-a overseas`。新项目为空库，旧数据在 protobuddy-app，迁移可选。

## 迭代 24：评审页批注列表面板可收起/展开
- 用户需求：右侧「批注列表」支持类似 Figma 的手动关闭/展开，优化预览区空间。
- 实现：Review.jsx 增加 panelOpen 状态并持久化到 localStorage；review-layout 动态 grid 宽度（320px ↔ 44px）+ 过渡动画。AnnotationLayer 新增 isOpen/onToggle，收起态渲染窄边栏（展开按钮、垂直标题「批注列表」、状态计数徽章、生成方案快捷按钮）。
- 部署：protobuddy（overseas, deployment dprr6h4w9h7v）已上线；protobuddy.20140107.xyz 与 protobuddy.edgeone.dev 均加载新 bundle `index-CUZtZkvm.js`。

## 迭代 25：方案生成 dry-run 匹配预检
- 需求：把「apply 时才发现 old_code 不匹配」的问题前移到生成阶段自动拦截。
- 实现（3 文件）：
  - `plans.js`：生成后立即预检每条 change（文件存在/非二进制/old_code 恰好匹配 1 次）；有 error 且走 Makers 时，把具体错误作为反馈**自动重新生成一次**，取错误更少的版本；plan 记录 `precheck` 汇总、planChange 记录 `validation` 明细。
  - `makersModels.js`：`generatePlanWithMakers` 新增 `retryFeedback` 参数，把上次的校验错误注入 userPrompt 让模型自我修正。
  - `PlanReview.jsx`：每条修改建议显示预检徽章（✓ 唯一匹配 / ⚠ 警告 / ✕ 未通过 + 原因）；方案摘要卡显示预检横幅（含自动重试说明）；应用确认框对「已批准但预检失败」的条目给出警告。
- 验证：本地端到端两条路径均过——坏路径（目标文件不存在 → error 正确捕获）、好路径（唯一匹配 → ok, match_count=1）。
- 部署：protobuddy（overseas, deployment dp37vpupe4we），protobuddy.20140107.xyz 与 protobuddy.edgeone.dev 均已加载新 bundle `index-BBxBgUxR.js`。git 5e44eb4。

## 迭代 26：批注→方案一致性检查
- 需求：校验生成的方案是否真正回应了批注诉求（此前方案可能通过匹配预检却完全偏离批注意图）。
- 实现（3 文件）：
  - 新增 `consistency.js`：纯本地语义粗筛——批注文本对每条 change（description + new_code 摘录）的字符二元组包含率打分；`annotation_id` 直接关联计 0.4；页面文件精确匹配仅在文本分 ≥0.12 时作确认加强（单独不构成证据，避免同页误判）。每条批注输出 covered / weak / uncovered。
  - `plans.js`：一致性检查与 dry-run 预检共用同一次自动重试（触发：任一 error 或任一未回应批注，仅 Makers 法）；采纳标准先比 error 数再比 uncovered 数；plan 记录新增 `consistency` 汇总+逐批注重果。
  - `PlanReview.jsx`：摘要卡一致性横幅（红色列出未回应批注原文与处理建议 / 绿色统计），change 头部「批注 #id」徽章。
- 验证：单测（真实回应→covered、偏离诉求→uncovered 且反馈文本正确）；本地 e2e 规则引擎路径 covered score 0.73/1.0。
- 部署：protobuddy（overseas, deployment dpsc20zpd10w），两域名均加载 `index-B_XGAt9I.js`。git 5dd7b26。

## 迭代 27：回归快照与一键回滚
- 需求：apply 前自动保存文件快照；应用失败或线上效果不对时可一键恢复到应用前状态。
- 实现：
  - apply 前对去重后的目标文件集合逐个快照到新表 `snapshots`（二进制跳过）；响应带 `snapshot_id`，409 带 `rollback_hint`。
  - 新端点 `POST /api/plans/:planId/rollback`（owner）：恢复最新 active 快照的全部文件 → applied 修改回「已通过」→ 被解决批注重新打开 → plan 回 approved → 快照标记 rolled_back（一次性，二次回滚 400）→ 自动重新部署（支持 ?force=1，与 apply 共用抽取出的 `triggerRedeploy`，生成器/regenerateRequired 语义不变）。
  - 方案列表/详情附加 `rollback_available`。
  - 前端：摘要卡红色「↩ 回滚到应用前」按钮（确认警告 + 回滚中状态 + regenerate 横幅复用）；apply 失败 toast 指引回滚。
- 验证（本地 e2e 全闭环）：apply（快照 #10030 创建、文件被修改、批注 resolved）→ rollback（restoredCount=1、changesReset=1、重新部署）→ 文件恢复原状、批注 open、plan/change 均 approved、rollback_available=false、二次回滚 400。
- 部署：protobuddy（overseas, deployment dpl3olq6fo8m），两域名均加载 `index-D1AQEJKk.js`。git 9c6424f。

## 迭代 28：方案质量评分卡（质量保障四项收尾）
- 需求：综合路径合规/匹配质量/批注一致性/描述/明确性给方案打分，低于阈值标记「需重点审查」。
- 实现（2 文件）：
  - `plans.js`：生成流程末尾 `computeScorecard()`——纯本地加权评分 0-100（路径 20 / 匹配 30 / 一致性 25 / 描述 10 / 明确性 15），全部复用已算好的 validations/consistency/knownPaths，零额外 API 消耗；`needs_review = 分数<70 或 任一预检 error`；plan 记录新增 `scorecard{score, grade, needs_review, dimensions[]}`。
  - `PlanReview.jsx`：摘要卡评分卡横幅（大分数块 + 等级文案 + 5 维度进度条，红/黄/绿配色）；方案列表按钮显示分数徽章（needs_review 带 ⚠）。
- 验证：单测三场景（高质量 100 / 低质量 28 需审查 / 中等 60 需审查）；本地 e2e 规则引擎路径 scorecard 100/good 完整落库。
- 部署：protobuddy（overseas, deployment dp0k2bg5ruhx），两域名均加载 `index-Bf1A08Dp.js`。git 2e98eb4。

## 迭代 29：生成器双写——跳过外部 Python 重新生成
- 需求：apply 改了 `_gen_pages.py` 时，线上 blob 环境无法执行 Python，此前必须本机跑 `regenerate.js`。让模型同时改 `.py` 和 `.html`，部署时 HTML 已是最新，跳过外部执行。
- 实现（4 文件）：
  - `generator.js` `prepareForDeploy`：接收 `changes` 参数，blob 模式下三路分类——① 未碰 `.py` → `skipped` 直接部署；② 碰了 `.py` 且碰了 `.html` → `synced` 直接部署（双写）；③ 只碰 `.py` → `needsExternal`（兜底，仍需 `regenerate.js`）。
  - `plans.js` `triggerRedeploy`：接收 `changes`，抽 `doDeploy()` 闭包由 `synced`/`skipped`/无生成器共用；apply 端点传入已批准 changes，响应体带 `dualWriteSynced`。
  - `makersModels.js` systemPrompt：新增 GENERATOR DUAL-WRITE 规则——生成器场景必须成对产出 `.py`（源代码一致性）+ `.html`（部署用产物），description 互相引用。
  - `PlanReview.jsx`：change 头部 `.py` + `.html` 成对时显示「双写」/「双写·产物」徽章；apply 成功 toast 报告同步 HTML 数量。
- 验证：单测五场景全对（只改.py→needsExternal / 双写→synced / 只改.html→skipped / 改.css→skipped / 改.py+改.css→needsExternal）；本地 e2e local 模式 apply 不回归（ran:true 路径正常）。
- 部署：protobuddy（overseas, deployment dpflteq5zhug），两域名均加载 `index-CVq5vXMN.js`。git 0373257。
