# 图灵商务平台交接手册

更新时间：2026-06-30  
当前仓库路径：`C:\Users\29272\Documents\在线商务平台`  
Obsidian 归档路径：`D:\主盘\图灵集市\图灵商务平台开发`  
GitHub 目标仓库：`https://github.com/derrickyang1998/Turingsalesworkingplatform`

## 1. 项目定位

图灵商务平台 / TuringMarket 是面向海外品牌推广、红人营销和商务线索管理的工作平台。当前工作区是一个静态前端基线，主要用于继续 CRM、品牌智库、需求方案、网红匹配、AI 助手、管理和知识库等模块的产品开发。

## 2. 当前技术形态

- 运行形态：静态 HTML + 模块化浏览器 JS。
- 入口文件：`site_home.html`。
- 旧合并文件：`site_app.js`，内容与静态页面基线相关，后续以 `site_home.html` + `js/` 模块为主。
- 业务模块：`js/modules/*`。
- 共享工具：`js/shared/utils.js`、`js/shared/dom.js`。
- 数据存储：浏览器 `localStorage`。
- PPT 生成：浏览器侧 `pptxgenjs@3.12.0` CDN。
- 当前仓库没有 `package.json`、后端 API、数据库配置或 `.env`。

## 3. 模块说明

| 模块 | 文件 | 当前状态 |
|---|---|---|
| M0 客户 CRM | `js/modules/m0-customer.js` | 客户、商机、阶段、看板、本地保存 |
| M1 品牌智库 | `js/modules/m1-brand.js` | 品牌样本、搜索、归档知识库 |
| M2 策略规划 | `js/modules/m2-strategy.js` | 从需求生成策略摘要 |
| M3 需求方案 | `js/modules/m3-demand.js` | 需求录入、AI 草稿、人审确认、导出 PPT/HTML |
| M4 网红匹配 | `js/modules/m4-influencer.js` | 轻量占位 |
| M5 AI 助手 | `js/modules/m5-assistant.js` | 基于本地需求的摘要式助手 |
| Admin 管理 | `js/modules/admin.js` | 静态用户管理占位 |
| KB 知识库 | `js/modules/kb.js` | 本地知识库、归档、搜索 |

## 4. 新设备接手步骤

1. 安装 Git、Node.js、Python 3 和常用编辑器。
2. 克隆 GitHub 仓库：

```powershell
git clone https://github.com/derrickyang1998/Turingsalesworkingplatform.git
cd Turingsalesworkingplatform
```

3. 复制环境模板：

```powershell
copy .env.example .env.local
```

4. 从私有 Obsidian 归档或团队密钥管理器填入真实密钥，不要提交 `.env.local`。
5. 启动静态服务：

```powershell
python -m http.server 8017
```

6. 打开 `http://127.0.0.1:8017/site_home.html`。
7. 开发前先看 `CHANGELOG.md`、`docs/version-records/` 和 `docs/DEVELOPMENT_WORKFLOW.md`。

## 5. 当前已知风险

- 当前仓库没有真实后端，所有业务数据保存在本地浏览器，换浏览器或清缓存会丢失演示数据。
- 真实 AI API 尚未接入当前静态版；M3 的“AI 草稿”是本地规则生成。
- PPT 导出依赖外部 CDN，弱网或离线环境会失败。
- 历史远端生产线与当前静态前端仓库不是同一套运行形态，接手时不要混淆版本号。
- 部分历史文档曾出现编码乱码，新的交接文档统一按 UTF-8 Markdown 维护。

## 6. 交接原则

- 每次迭代必须有版本号、Git 提交、变更说明、验证记录。
- 公开仓库只保存可公开代码和脱敏文档。
- 密钥、服务器密码、SSH 私钥只放私有密钥管理器或本机 Obsidian 私有目录。
- AI 相关流程继续保持“AI 草稿 -> 人工编辑确认 -> 最终生成”的产品逻辑。

