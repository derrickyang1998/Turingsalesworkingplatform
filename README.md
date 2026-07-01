# TuringMarket 图灵商务在线工作平台

> **全球首个按效果付费海外红人Agent** — AI驱动的出海品牌红人营销全流程平台
> 
> 官方网站: [turingmarket.cn](https://www.turingmarket.cn) | 在线平台: [8.163.129.160](http://8.163.129.160)

---

## 项目概述

TuringMarket 是为商务团队打造的线上SOP工作平台，覆盖从客户开发到网红提报的全流程：

```
客户获取 → 客户信息确认 → 行业/竞品数据分析 → 红人营销方案生成 → 网红匹配提报 → 合作落地跟踪
```

**核心数据：** 7000万+ 海外红人库 | 服务上千出海品牌 | 12+ 行业覆盖 | 全球布局深圳/北京/杭州/纽约

---

## 功能模块 (v7.0)

| 模块 | 标识 | 功能描述 |
|------|------|----------|
| 客户管道 | M0 | 商务SOP全流程跟踪，线索→成交，阶段筛选，状态管理 |
| 行业品牌智库 | M1 | 1871个出海品牌，13大行业，189个细分标签，AI数据补充 |
| 客户策略规划 | M2 | 品牌阶段×行业×预算×目标→自动策略建议→行业对标 |
| 需求接入 & 方案生成 | M3 | 文件上传→AI解析→智能分析→一键生成PPT/Word方案 |
| 网红匹配 & 执行管理 | M4 | 提报资源名单，下单合作追踪，飞书同步 |
| AI 助手 | M5 | DeepSeek V4 Flash，基于品牌数据库的策略咨询 |
| 管理控制室 | Admin | 全盘需求监控，用户管理，Token消耗追踪 |

---

## 技术架构

| 层级 | 技术 |
|------|------|
| 前端 | 纯 HTML/CSS/JS (Vanilla) — 零框架依赖 |
| 后端 | Node.js + Express 5 |
| 数据库 | sql.js (纯 JavaScript SQLite，零编译) |
| AI | DeepSeek API (V4 Pro) |
| 测试 | Playwright (端到端自动化) |
| 部署 | Ubuntu 22.04 + PM2 + Nginx |
| 版本管理 | Git + GitHub |

---

## 一键部署

```bash
git clone https://github.com/derrickyang1998/Turingsalesworkingplatform.git
cd Turingsalesworkingplatform/platform
sudo bash install.sh
```

详细指南: [DEPLOY.md](platform/DEPLOY.md)

**登录账号：** 由管理员在平台后台创建；初始密码和重置密码只通过私有环境或后台一次性返回，不写入仓库。

---

## 版本历史

| 版本 | 日期 | 里程碑 |
|------|------|--------|
| v1.0 | 2025-05 | 初始概念：行业品牌智库 (M1) + 客户策略规划 (M2) |
| v5.1 | 2025-06 | Codex接手开发，确立完整架构基线 |
| v5.2 | - | 网红数据库 + 智能匹配 (M4) |
| v5.3 | - | 客户管道 SOP (M0) |
| v5.4 | - | 模块互联 — SOP管道链接各模块 |
| v5.5 | - | M2-M5 + Admin 清零重建 |
| v6.0 | - | 全部7个模块完成 (HTML+JS) |
| **v7.0** | **2025-06-04** | **生产就绪：页面隔离修复，阿里云部署，一键安装** |

完整变更日志: [CHANGELOG.md](CHANGELOG.md)

---

## 公司背景

图灵集市 TuringMarket — 专注海外红人营销的AI驱动服务商

- **服务模式：** 按效果付费 (Performance-based) | 全流程托管 | SaaS产品 | API数据合作
- **方法论：** 60-30-10 ROI优化模型，小型创作者(Nano/Micro)优先策略
- **曾服务品牌：** Anker, Xiaomi, Shein, Bluetti, Ugreen, Narwal 等
- **团队成员：** 来自 Dji, Anker, 创想三维, 传音等品牌大厂

---

## 开发者

代码仓库由 Codex AI 驱动开发。商务需求由 TuringMarket 团队提供。

📧 联系: admin@turingmarket.cn
