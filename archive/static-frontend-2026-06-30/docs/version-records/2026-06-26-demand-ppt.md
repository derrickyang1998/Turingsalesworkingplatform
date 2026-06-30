# 2026-06-26 需求接入与 PPT 生成版本记录

## 基线

- 工作目录：`C:\Users\29272\Documents\在线商务平台`
- 初始文件：`site_home.html`、`site_app.js`
- 初始状态：页面已经包含顶部导航、M3 容器和 `pptxgenjs` CDN 引用，但 `js/shared/*`、`js/modules/*`、`js/app.js` 尚未完整拆分，点击业务模块会缺少对象实现。

## 本次交付

- 补齐静态应用运行骨架：共享工具、本地存储、toast、模块切换、CRM 客户列表。
- 新增 M3「需求方案」闭环：
  - 需求接入表单：品牌、行业、市场、产品、目标、受众、平台、预算、周期、交付物、补充需求、参考链接。
  - 支持 `.txt/.md` 需求文本导入。
  - 本地保存需求到 `tm_demands`，并同步客户线索到 `tm_customers`。
  - 基于需求和知识库匹配生成可编辑方案草稿。
  - 保留“AI 草稿 -> 人工修改确认 -> 导出 PPT/HTML”的三段式流程。
  - 确认方案后归档到 `tm_knowledge_base`。
  - 导出 PPTX 和 HTML 方案文件。
- 补齐轻量模块：品牌智库、策略规划、网红匹配、AI 助手、管理、知识库，保证顶部导航不报错。

## 关键文件

- `js/shared/utils.js`
- `js/shared/dom.js`
- `js/app.js`
- `js/modules/m0-customer.js`
- `js/modules/m1-brand.js`
- `js/modules/m2-strategy.js`
- `js/modules/m3-demand.js`
- `js/modules/m4-influencer.js`
- `js/modules/m5-assistant.js`
- `js/modules/admin.js`
- `js/modules/kb.js`

## 验证

- `node --check`：所有新增 JS 文件通过语法检查。
- Playwright 浏览器冒烟：
  - 打开 `http://127.0.0.1:8017/site_home.html`
  - 进入“需求方案”
  - 填写测试需求 `LumiSkin`
  - 生成 AI 草稿
  - 确认方案
  - 确认本地状态：`tm_demands[0].status === "confirmed"`，知识库条目数增加到 4
  - 成功下载 `LumiSkin-influencer-proposal-2026-06-26.pptx`
  - 成功下载 `LumiSkin-influencer-proposal-2026-06-26.html`

## 后续建议

- 接入后端 API 后，将 `tm_demands`、`tm_customers`、`tm_knowledge_base` 替换为服务端存储。
- 接入真实 AI 时，保留现有确认门槛：AI 只生成草稿，人工确认后才允许最终文件生成。
- PPT 模板可继续扩展为多套行业模板，例如美妆、3C、家居和母婴。

