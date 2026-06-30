# 团队版本迭代与同步规范

更新时间：2026-06-30

## 专业团队通常怎么做

成熟团队一般不会靠聊天记录同步版本，而是用下面几层机制：

1. Git 是唯一代码事实来源：所有代码、公开文档、版本记录都进仓库。
2. 需求和任务进 Issue：每个功能、Bug、运营需求都有编号和负责人。
3. 分支开发：`main` 保持稳定，功能走 `feature/*` 或 `codex/*` 分支。
4. Pull Request 合并：PR 里写清楚变更、影响、验证方式，由他人 review。
5. 版本号和 Changelog：每次可交付版本打 tag，例如 `v0.2.0`。
6. CI 自动检查：提交后自动跑语法检查、测试、构建。
7. 密钥不进仓库：只进 Secret Manager 或 GitHub Actions Secrets。
8. 发布有回滚方案：每次部署知道从哪个 tag 发布，失败可回滚。

## 本项目版本号规则

采用 SemVer：

- `MAJOR`：架构或数据模型不兼容的大版本，例如从静态版迁移到完整 SaaS 后端。
- `MINOR`：新增模块或明显业务能力，例如接入真实 AI、上线客户公海池后端。
- `PATCH`：修复问题、文案、样式、兼容性和小改动。

示例：

- `v0.1.0`：当前静态前端交接基线。
- `v0.2.0`：接入真实后端 API。
- `v0.2.1`：修复客户保存后列表不刷新。
- `v1.0.0`：多用户权限、后端、部署、备份和核心 CRM 流程稳定可用。

## 分支规则

- `main` 或 `master`：稳定主线，只接受 PR 合并。
- `codex/<short-name>`：Codex 开发分支。
- `feature/<short-name>`：人工开发功能分支。
- `fix/<short-name>`：Bug 修复分支。
- `release/vX.Y.Z`：发布准备分支。

## 每次迭代必须更新

- `CHANGELOG.md`
- `docs/version-records/YYYY-MM-DD-vX.Y.Z-xxx.md`
- 相关交接文档，如果运行方式、密钥、部署或模块边界变化
- `.env.example`，如果新增环境变量

## 推荐 PR 模板

```markdown
## 变更内容

- 

## 影响范围

- 

## 验证

- [ ] node --check
- [ ] 本地页面冒烟测试
- [ ] 关键业务流程测试

## 风险与回滚

- 
```

## 发布流程

1. 从最新主线拉分支。
2. 开发并提交。
3. 更新版本记录。
4. 运行验证。
5. 推送分支并创建 PR。
6. Review 通过后合并。
7. 打 tag：`git tag vX.Y.Z`。
8. 推送 tag：`git push origin vX.Y.Z`。
9. 部署对应 tag。
10. 在 Obsidian 同步发布记录。

