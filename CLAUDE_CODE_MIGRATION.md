# ==============================
# TURINGMARKET 图灵商务平台
# 完整上下文迁移文档
# → Claude Code 接力开发
# ==============================

## 🔑 API KEYS & 凭据

DEEPSEEK_API_KEY=replace_with_private_value
SERVER_IP=8.163.129.160
SSH_KEY=C:\Users\29272\.ssh\turingmarket_deploy
ROOT_PASSWORD=replace_with_private_value
GITHUB_REPO=https://github.com/derrickyang1998/Turingsalesworkingplatform
GIT_BRANCH=codex/phase-2-customer-pipeline → master (force push)
ADMIN_LOGIN=admin / replace_with_private_value
TEAM_ACCOUNTS=10 users (zhangwei, wangfang...), passwords stored privately
NODE_VERSION=v20.20.2 (Ubuntu)
SERVER_DIR=/root/turingmarket/platform
DB_TYPE=sql.js (纯JS WASM SQLite, 零编译)
PORT=3002 (Node) / 80 (Nginx代理)

## 📂 文件结构

platform/
├── app.js          (81KB 前端主逻辑 — 7个模块全部JS)
├── index.html      (40KB 主页面 — 7个模块HTML+CSS)
├── server/
│   ├── server.js   (12KB Express API — 23个路由)
│   ├── start.js    (启动入口: DB初始化+建表+种子数据)
│   ├── db.js       (sql.js 包装器: init/prepare/exec)
│   ├── routes.js   (网红/合作路由)
│   ├── routes_brands.js
│   ├── routes_customers.js
│   └── package.json
├── install.sh      (一键部署脚本)
├── DEPLOY.md       (部署指南)
├── ecosystem.config.js (PM2配置)
└── data/           (品牌数据JSON)

## 📍 最新提交 (8aa0c71)

HOTFIX: remove broken searchHint string causing SyntaxError at line 326
→ 之前v7.4的searchHint代码破坏了app.js语法

## 📊 各模块状态

M0 客户库CRM  ✅  — 公海池/认领/商机/去重/仪表盘
M1 品牌智库   ✅  — 搜索/相似品牌/工具提示/归档
M2 策略规划   ✅  — DeepSeek V4 AI分析/联网搜索上下文
M3 需求方案   ✅  — 文件AI分析/HTML导出/手动编辑确认
M4 网红匹配   ✅  — 19列模板/5条件筛选/CSV导出
M5 AI助手    ✅  — localStorage记忆系统/上下文对话
ADMIN 管理   ✅  — 用户CRUD/跨用户可见/激活/重置密码
KB 知识库    ✅  — 自动归档/搜索/离线缓存

## ⚠️ 已知问题/待优化

- server.js 经常在base64上传时被截断（首字符"c"）
- 建议改用 scp 或 Python 方式上传文件
- 筛选标签（开发中/方案/谈判）部分无法点击切换
- M2-AI策略分析需要DeepSeek API实时可用
- 待集成: PPT生成(需要 presentations skill)

## 📜 版本演进

v7.4 — Brand tooltips, AI search context, Admin visibility
v7.3 — 客户库保存/显示/去重全部修复
v7.2 — saveCustomer补stage字段+去重检测
v7.1 — Salesforce风格客户库+看板+详情面板
v7.0 — 7模块全部上线+阿里云部署
v5.1→v6.0 — 全功能开发

## 🔧 架构要点

1. Express 5.x — app.use(express.json)必须写在路由最前面
2. sql.js — prepare().all(params)当params为空时用 all() 不传参
3. 路由顺序: check-duplicate 必须在 /:id 之前
4. 前端 switchPage → style.display = 'none'/'block'
5. 页面不堆叠: 每次显式设所有隐藏再显目标
6. clone部署: git clone → cd platform → sudo bash install.sh
