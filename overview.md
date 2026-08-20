# 任务概览：评审页预览区宽度增大

**提交**: main · 2026-08-20 · 已部署 protobuddy.20140107.xyz（deployment dpb4pug22msc）

## 背景

评审页（`/project/:id/review`）原先受 `.main-content { max-width: 1400px; }` 限制，在宽屏上预览区无法占满整个可用宽度；右侧批注面板固定 320px，中间留给 iframe 原型的空间不足，导致原型展示被压缩、两侧留空较多。

## 改动方案

### 1. 评审页全宽布局

- 为 `.review-main` 覆盖 `max-width: none`，取消 1400px 上限。
- 将 `.review-main` 的 padding 从 24px 收紧到 16px，进一步释放有效宽度。

### 2. 收紧右侧批注面板占用

- 批注面板宽度从 320px 缩至 300px。
- `review-layout` 的 grid gap 从 16px 缩至 12px。
- 收起面板后的宽度保持 44px 不变。

### 3. 同步 React 内联样式

- `Review.jsx` 中 `gridTemplateColumns` 的展开态同步改为 `1fr 300px`，与 CSS 一致。

## 验证情况

- 本地 `npm run build` 通过，生成新 dist。
- EdgeOne Makers 部署成功：`dpb4pug22msc`。
- 线上 CSS 已包含 `.review-main{height:100%;max-width:none;padding:16px}`，样式生效。

## 文件变更

- `frontend/src/styles.css`：`.review-main` 全宽、`review-layout` 列宽与间距调整。
- `frontend/src/pages/Review.jsx`：`gridTemplateColumns` 内联样式同步 300px。

## 后续事项

1. 若用户屏幕较窄或批注较多，仍可点击右侧批注面板顶部的收起按钮，使预览区占满除 44px 收起条外的全部宽度。
2. 如原型页面本身有固定宽度容器且小于预览区，仍会出现居中留白；这属于原型 HTML 自身布局问题，可通过修改原型的 CSS（如把固定宽度容器改为 `width: 100%`）解决。
