# Changelog — TuringMarket 图灵商务在线工作平台

## v7.0 (2025-06-04) — 生产就绪版本

### 🎯 里程碑
- ✅ 全部7个模块可正常使用，页面切换不堆积
- ✅ 阿里云生产环境部署 (8.163.129.160)
- ✅ 一键安装脚本 (install.sh)
- ✅ GitHub 完整存档

### 🐛 修复
- **页面白屏问题（根因）:** index.html 缺少1个 `</div>` 导致 M2-M7 被嵌套在 M1 内部，M1隐藏时所有子页面不可见
- **页面堆积问题:** switchPage 未清除旧页面的 `display:block` 样式残留
- **CSS基线错误:** `.page{display:block}` → `.page{display:none}` (默认值修正)
- **JavaScript干扰:** 移除 app.js 第103行设置 `setAttribute('style','display:none')` 的IIFE
- **DOM修复脚本:** 页面加载后自动将 `page-*` div 移入 `<main>` 作为直接子元素
- **sql.js包装器:** `.run()` 方法不支持多参数传递的问题

### 🔧 技术改进
- switchPage 改用 `element.style.display` (而非 `setAttribute`) 精确控制显隐
- 服务端使用 sql.js (纯JS SQLite) 替代 better-sqlite3 (Ubuntu 26.04 不兼容)
- SSH管道分块上传机制 (避免命令行长度限制)
- Playwright 端到端测试集成

### 📦 部署
- Nginx 80端口代理 → Express 3002端口
- PM2 进程管理
- 10个商务团队账号 + 1个管理员账号

---

## v6.0 — 全平台7模块

- feat: 全部7个模块 HTML + JavaScript 骨架完成
- M0: 客户管道 (Customer Pipeline)
- M1: 行业品牌智库 (Brand Intelligence Hub)
- M2: 客户策略规划 (Strategy Planning)
- M3: 需求接入 & 方案生成 (Demand & Proposal)
- M4: 网红匹配 & 执行管理 (Influencer Matching)
- M5: AI 助手 (AI Assistant)
- Admin: 管理控制室 (Admin Dashboard)
- 下拉选择器导航 + 侧边栏导航双入口

---

## v5.5 — M2-M5 + Admin 清零重建

- refactor: 清空 M2-M5 + Admin 代码
- 以 M0/M1 的交互逻辑为基准完全重写
- 统一页面切换机制

---

## v5.4 — 模块互联 (SOP Pipeline)

- feat: 客户管道 ↔ 各模块双向链接
- 点击客户 → 跳转到对应分析模块
- 跨模块数据传输

---

## v5.3 — 客户管道 (SOP Backbone)

- feat: M0 客户管道完整功能
- 线索→意向→方案→谈判→成交→维护 全阶段跟踪
- 客户搜索、阶段筛选、状态管理
- loadCustomers / renderCustomerTable / saveCustomer

---

## v5.2 — 网红数据库 + 智能匹配

- feat: M4 网红数据库基础功能
- 网红导入、筛选、匹配
- 飞书表格集成
- initM4 / influencer table rendering

---

## v5.1 — Codex 接手开发

- chore: v5.1 基线快照
- 确立项目结构
- Express 5 后端 + 纯前端架构
- 多用户登录系统

---

## v1.0 — 初始概念

- M1: 行业品牌智库 — 标签树 + 品牌搜索 + 数据展示
- M2: 客户策略规划 — 品牌阶段×行业×预算策略模型
- 纯前端 HTML 双击运行
