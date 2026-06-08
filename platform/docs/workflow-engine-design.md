# 动态工作流引擎 — 设计方案

> 图灵商务平台 v3.1
> 2026-06-08

## 1. 概述

为图灵商务平台增加通用可配置动态工作流引擎，支持管理员通过拖拽式可视化设计器自定义业务流程，全局挂载到所有业务模块（CRM客户库、品牌智库、需求方案、网红匹配、合作等）。

### 核心能力

- **拖拽式可视化设计器** — 纯 SVG + Vanilla JS 自研画布
- **全功能节点** — 审批、条件分支、并行、定时、Webhook、自动动作、子流程
- **全局挂载** — 所有模块业务对象可触发工作流
- **可配置** — 管理员自定义流程模板，无需改代码

## 2. 技术选型

| 层面 | 选型 | 理由 |
|---|---|---|
| 前端画布 | SVG + Vanilla JS（自研） | 与现有纯JS SPA架构一致，零外部依赖 |
| 后端 | Express 5（现有） | 复用已有路由/auth中间件 |
| 数据库 | better-sqlite3（现有） | 5张新表 |
| 定时 | setInterval 轮询 | 轻量，符合服务器架构 |
| 条件引擎 | 表达式求值（JSON Logic） | 安全可配置 |

## 3. 架构图

```
┌─────────────────────────────────────────────────┐
│                   前端 (app.js / index.html)          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐   │
│  │流程设计器 │ │流程实例管理│ │我的待办  │ │各模块 │   │
│  │(SVG拖拽) │ │(监控/操作)│ │(审批/任务)│ │集成点 │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──┬───┘   │
└───────┼────────────┼────────────┼───────────┼──────┘
        │            │            │           │
        ▼            ▼            ▼           ▼
┌─────────────────────────────────────────────────┐
│                  后端 (Express 5)                    │
│  ┌──────────────────┐ ┌────────────────────┐       │
│  │ routes_workflow.js│ │ workflow_engine.js │       │
│  │ (API路由)        │ │ (核心执行引擎)     │       │
│  └──────┬───────────┘ └─────────┬──────────┘       │
│         │                      │                    │
│         ▼                      ▼                    │
│  ┌──────────────────────────────────────────┐       │
│  │     better-sqlite3                        │       │
│  │  workflow_templates (流程模板)            │       │
│  │  workflow_instances (流程实例)            │       │
│  │  workflow_tasks (任务/待办)               │       │
│  │  workflow_timers (定时器)                 │       │
│  │  workflow_node_logs (执行日志)            │       │
│  └──────────────────────────────────────────┘       │
└─────────────────────────────────────────────────┘
```

## 4. 数据模型

### 4.1 workflow_templates — 流程模板

```sql
CREATE TABLE workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  module TEXT,
  category TEXT,
  nodes JSON NOT NULL,
  edges JSON NOT NULL,
  version INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 workflow_instances — 流程实例

```sql
CREATE TABLE workflow_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  business_type TEXT NOT NULL,
  business_id INTEGER NOT NULL,
  current_node_id TEXT,
  status TEXT DEFAULT 'active',
  data JSON,
  started_by INTEGER,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.3 workflow_tasks — 任务/待办

```sql
CREATE TABLE workflow_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee_id INTEGER,
  assignee_role TEXT,
  status TEXT DEFAULT 'pending',
  comment TEXT,
  due_at DATETIME,
  completed_at DATETIME,
  completed_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.4 workflow_timers — 定时器

```sql
CREATE TABLE workflow_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  fire_at DATETIME NOT NULL,
  action TEXT DEFAULT 'advance',
  fired INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.5 workflow_node_logs — 执行日志

```sql
CREATE TABLE workflow_node_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id INTEGER,
  details JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 5. 节点类型

| 类型 | 标识 | 说明 | 配置项 |
|---|---|---|---|
| 开始 | start | 流程入口 | 触发条件（创建时/更新时/手动） |
| 结束 | end | 流程终点 | 成功/拒绝结束 |
| 审批 | approval | 人工审批节点 | 审批人/角色，通过/驳回流向 |
| 任务 | task | 人工执行任务 | 负责人/角色，完成条件 |
| 条件 | condition | IF/ELIF/ELSE分支 | 条件表达式 |
| 并行 | parallel | 多分支并行 | 分支列表，完成策略 |
| 定时 | timer | 等待指定时间 | 延迟时长/cron表达式 |
| Webhook | webhook | 调用外部API | URL/方法/Headers/Body |
| 自动动作 | auto_action | 自动执行 | 更新字段/发通知/创建记录 |
| 子流程 | sub_process | 调用其他模板 | 子流程模板ID |

## 6. SVG拖拽设计器

### 6.1 布局

```
┌─────────────────────────────────────────────┐
│  工具栏 [保存] [发布] [撤销] [重做] [预览]   │
├──────────┬──────────────────────────────────┤
│ 节点工具箱 │          画布 (SVG)              │
│ ┌──────┐ │  ┌─────────┐                     │
│ │开始  │ │  │ ● 开始   │                     │
│ │审批  │ │  │         │                     │
│ │条件  │ │  │   │     │                     │
│ │并行  │ │  │   ▼     │                     │
│ │定时  │ │  │ ◇ 条件  │                     │
│ │...   │ │  │  │  │   │                     │
│ └──────┘ │  └─────────┘                     │
├──────────┴──────────────────────────────────┤
│  属性面板 (选中节点/连线时显示配置)          │
└─────────────────────────────────────────────┘
```

### 6.2 交互

- **拖入节点**：从工具箱拖拽节点类型到画布
- **选中节点**：点击选中，显示配置面板
- **连线**：从节点底部锚点拖到目标节点顶部锚点
- **编辑**：双击节点打开配置
- **删除**：选中后按 Delete 或右键菜单
- **缩放**：鼠标滚轮缩放
- **平移**：按住空格+拖拽平移画布
- **撤销/重做**：操作历史栈

## 7. 工作流执行引擎

### 7.1 核心方法

| 方法 | 说明 |
|---|---|
| `startWorkflow(templateId, businessType, businessId, data)` | 启动流程 |
| `advanceNode(instanceId, nodeId)` | 推进到下一节点 |
| `handleTaskAction(taskId, action, userId, comment)` | 处理审批/任务 |
| `evaluateCondition(conditionExpr, context)` | 条件求值 |
| `checkTimers()` | 轮询定时器（setInterval 30s） |
| `pauseWorkflow(instanceId)` | 暂停流程 |
| `resumeWorkflow(instanceId)` | 恢复流程 |
| `cancelWorkflow(instanceId)` | 取消流程 |

### 7.2 执行流程

```
触发事件 → createWorkflowInstance → enterNode('start')
                                        ↓
                            executeNode(currentNode)
                                        ↓
                   ┌─── 审批/任务 → createTask → 等待处理
                   │   条件 → 评估 → 选择分支
                   │   并行 → 创建子实例
                   │   定时 → createTimer
                   │   Webhook → 调用API
                   │   自动动作 → 执行操作
                   │   子流程 → startWorkflow
                   │   结束 → completeInstance
                   └───────────────────────────
                                        ↓
                              advanceNode(下一节点)
```

### 7.3 条件表达式

使用 JSON Logic 格式，安全且可序列化：

```json
{ "==": [{ "var": "data.budget" }, "high"] }
{ "and": [
  { ">=": [{ "var": "data.value" }, 10000] },
  { "==": [{ "var": "data.region" }, "US"] }
]}
```

## 8. API 设计

### 流程模板管理

```
POST   /api/workflow/templates          — 创建模板
GET    /api/workflow/templates          — 列表
GET    /api/workflow/templates/:id      — 详情
PUT    /api/workflow/templates/:id      — 更新
DELETE /api/workflow/templates/:id      — 删除
POST   /api/workflow/templates/:id/publish — 发布
```

### 流程实例

```
POST   /api/workflow/instances                  — 手动启动流程
GET    /api/workflow/instances                   — 实例列表
GET    /api/workflow/instances/:id               — 实例详情
POST   /api/workflow/instances/:id/pause         — 暂停
POST   /api/workflow/instances/:id/resume        — 恢复
POST   /api/workflow/instances/:id/cancel        — 取消
GET    /api/workflow/instances/by-business       — 按业务对象查
```

### 任务

```
GET    /api/workflow/tasks              — 我的待办
GET    /api/workflow/tasks/:id          — 任务详情
POST   /api/workflow/tasks/:id/approve  — 审批通过
POST   /api/workflow/tasks/:id/reject   — 审批驳回
POST   /api/workflow/tasks/:id/complete — 完成任务
```

### 引擎状态

```
GET    /api/workflow/stats              — 引擎统计
POST   /api/workflow/check-timers       — 手动触发定时检查
```

## 9. 与现有模块集成

### 9.1 触发点注入

在现有 CRUD 操作后注入工作流检测：

| 模块 | 触发点 | 传递数据 |
|---|---|---|
| CRM客户库 | 创建客户、阶段变更 | customer对象 + stage |
| 需求方案 | 创建需求、状态变更 | demand对象 |
| 网红匹配 | 创建合作、状态变更 | collaboration对象 |
| 品牌智库 | 新增品牌 | brand对象 |
| 策略规划 | 生成策略 | proposal对象 |

### 9.2 前端集成点

每个业务对象详情页增加：
- 关联流程状态卡片
- "发起审批"按钮
- 流程进度条

## 10. 文件清单

```
platform/
├── server/
│   ├── routes_workflow.js       (API路由 ~200行)
│   ├── workflow_engine.js       (核心引擎 ~300行)
│   └── db.js                    (追加5张新表)
├── workflow/
│   ├── workflow-designer.html   (设计器HTML ~500行)
│   ├── workflow-designer.js     (设计器JS ~800行)
│   ├── workflow-instances.html  (实例管理 ~200行)
│   ├── workflow-instances.js    (实例管理JS ~300行)
│   ├── workflow-tasks.html      (我的待办 ~200行)
│   └── workflow-tasks.js        (我的待办JS ~200行)
├── app.js                       (追加工作流页面切换)
└── index.html                   (追加工作流入口菜单)
```

## 11. 实施计划

### 第一阶段：基础框架（后端+DB）
1. DB：追加5张新表
2. workflow_engine.js：核心引擎
3. routes_workflow.js：完整API
4. 与现有 auth 中间件集成

### 第二阶段：SVG设计器
1. 画布引擎（拖拽/缩放/连线）
2. 节点工具箱
3. 属性配置面板
4. 保存/加载/发布

### 第三阶段：流程执行
1. 流程实例管理页面
2. 我的待办页面
3. 审批/任务处理
4. 定时器轮询

### 第四阶段：全局集成
1. CRM客户库触发点
2. 其他模块触发点
3. 业务对象详情页集成
4. 端到端测试
