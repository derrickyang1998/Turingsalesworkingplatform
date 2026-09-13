# 商务新人红人营销培训体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一套可教学、可实操、可考核且能持续更新的图灵集市商务新人海外红人营销培训体系。

**Architecture:** 主SOP只保留培训门禁与索引；稳定营销知识进入基础手册；易变化的平台功能、受众、内容、链接和商业化路径进入独立平台档案；产品匹配、达人评分、Roleplay和认证各自独立维护。所有动态事实通过来源台账追踪，正式文件保留旧版并生成新版本。

**Tech Stack:** UTF-8 Markdown、PowerShell结构校验、Git版本记录、Obsidian知识库归档、平台官方Help/Business/Creator资料。

**Spec:** `docs/superpowers/specs/2026-09-08-sales-training-knowledge-system-design.md`

## Global Constraints

- 核心平台为 YouTube、TikTok、Instagram；标准扩展平台为 Facebook、X、Pinterest、Reddit、LinkedIn；特殊场景平台为 Snapchat、Twitch、Threads、Discord。
- Amazon Influencer、联盟网络和独立站 Affiliate 作为商业转化渠道单列，不混入社交平台机制。
- 每个平台必须覆盖平台特性、主要受众、内容类型、商业合作形式、常规要求、链接能力、转化路径、指标、风险、官方来源和核验日期。
- 商务负责达人初筛、推荐逻辑和重大风险识别；运营负责最终达人名单专业复核。
- 平台数据、价格和互动率均为动态信息，不作为固定答案或对客保证。
- 产品选择使用条件式判断，不采用“行业等于平台”的固定规则。
- 动态平台事实优先使用官方来源；图灵真实项目数据优先于第三方行业平均值。
- 新版文件不得覆盖或删除旧版文件。
- 不修改CRM代码、不制定提成制度、不修改法务和财务审批制度。
- 只提交本计划产生的文件；保留当前工作区内其他未提交或已暂存变更。

---

## File Structure

### Create

- `商务培训/00-培训资料索引与版本说明.md`：唯一课程入口、学习顺序、文件关系和版本状态。
- `商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md`：稳定营销基础、决策框架、指标、归因和合规知识。
- `商务培训/02-主流社媒平台档案与商业化路径-v1.0.md`：12个平台的动态档案、内容、商业合作、链接和转化路径。
- `商务培训/03-产品平台达人内容匹配案例库-v1.0.md`：8个重点行业的条件式案例与评分答案。
- `商务培训/04-达人质量评估评分卡-v1.0.md`：硬门槛、100分评分、证据置信度和平台差异化检查。
- `商务培训/05-商务新人Roleplay与知识题库-v2.0.md`：知识题、案例题、Roleplay、答案和评分锚点。
- `商务培训/06-五周培养与上岗认证-v1.0.md`：课表、作业、陪访、考试、补考和上岗门禁。
- `商务培训/07-平台事实与来源维护台账-v1.0.md`：事实、来源、适用市场、核验日、失效风险和Owner。
- `商务团队客户全生命周期与日常作业SOP-v2.1.md`：保留v2.0，新增培训索引、认证门禁和版本记录。

### Modify

- `CHANGELOG.md`：追加本次商务培训体系版本记录，保留现有未提交内容。

### Preserve

- `商务团队客户全生命周期与日常作业SOP-v2.0.md`
- `商务新人Roleplay-销售场景模拟考核方案.md`
- `D:/主盘/图灵集市/内部知识文件/02-海外红人营销销售培训手册2026版.md`
- `D:/主盘/图灵集市/内部知识文件/06-网红营销实战手册2026版(含合同模板).md`

---

### Task 1: 建立培训索引与平台事实台账

**Files:**
- Create: `商务培训/00-培训资料索引与版本说明.md`
- Create: `商务培训/07-平台事实与来源维护台账-v1.0.md`

**Interfaces:**
- Consumes: 设计规格、两本内部手册、现有SOP和Roleplay。
- Produces: 后续所有文件引用的来源等级、平台清单、核验日期和课程导航。

- [ ] **Step 1: 读取并记录内部来源基线**

读取四份现有材料，记录文件名、版本、用途、最后修改时间和SHA256。内部资料分工必须写明：SOP管流程，销售手册提供概念素材，实战手册提供执行素材，Roleplay提供历史考核素材。

Run:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath @(
  '商务团队客户全生命周期与日常作业SOP-v2.0.md',
  '商务新人Roleplay-销售场景模拟考核方案.md',
  'D:\主盘\图灵集市\内部知识文件\02-海外红人营销销售培训手册2026版.md',
  'D:\主盘\图灵集市\内部知识文件\06-网红营销实战手册2026版(含合同模板).md'
)
```

Expected: 四份文件均存在并返回SHA256；不修改原文件。

- [ ] **Step 2: 建立平台事实来源表**

为12个平台各建立行项目，字段固定为：平台、事实主题、结论摘要、来源级别、官方URL、适用市场、账号或资格条件、核验日期、建议复核日、维护Owner、状态。核心平台每个平台至少4个官方来源，标准扩展平台至少2个，特殊场景平台至少1个。

官方检索范围：

```text
YouTube: support.google.com/youtube, blog.youtube
TikTok: support.tiktok.com, newsroom.tiktok.com, ads.tiktok.com
Instagram/Facebook/Threads: about.fb.com, facebook.com/business, facebook.com/help/instagram
X: business.x.com, help.x.com
Pinterest: help.pinterest.com, business.pinterest.com
Reddit: support.reddithelp.com, business.reddithelp.com
LinkedIn: linkedin.com/help, business.linkedin.com
Snapchat: help.snapchat.com, forbusiness.snapchat.com
Twitch: help.twitch.tv, safety.twitch.tv
Discord: support.discord.com, discord.com/safety
```

- [ ] **Step 3: 标记内部手册的高风险旧口径**

台账至少记录以下需要纠正或降级的内容：Shorts最多60秒、IGTV、固定全球MAU、固定平台互动率、固定达人报价、“YouTube一定转化最高”、“TikTok一定最便宜”、平台商店全球可用、把自然发布权等同于广告投放权。

- [ ] **Step 4: 写课程索引**

索引按01至07顺序说明：适用对象、学习顺序、每份文件用途、当前版本、培训Owner、平台Owner、季度更新机制和旧版保留规则。

- [ ] **Step 5: 校验任务产物**

Run:

```powershell
rg -n 'YouTube|TikTok|Instagram|Facebook|Pinterest|Reddit|LinkedIn|Snapchat|Twitch|Threads|Discord|核验日期|官方URL|维护Owner' 商务培训/07-平台事实与来源维护台账-v1.0.md
rg -n '01-|02-|03-|04-|05-|06-|07-' 商务培训/00-培训资料索引与版本说明.md
```

Expected: 12个平台全部出现，来源台账字段完整，索引覆盖全部7份培训文件。

- [ ] **Step 6: 提交本任务文件**

```powershell
git add -- '商务培训/00-培训资料索引与版本说明.md' '商务培训/07-平台事实与来源维护台账-v1.0.md'
git commit --only -m 'docs: add sales training source ledger' -- '商务培训/00-培训资料索引与版本说明.md' '商务培训/07-平台事实与来源维护台账-v1.0.md'
```

---

### Task 2: 编写12个平台档案与商业化路径

**Files:**
- Create: `商务培训/02-主流社媒平台档案与商业化路径-v1.0.md`

**Interfaces:**
- Consumes: `商务培训/07-平台事实与来源维护台账-v1.0.md`
- Produces: 主手册、案例库、题库共同引用的平台事实源。

- [ ] **Step 1: 建立跨平台总览矩阵**

矩阵列固定为：平台、核心角色、主要受众、发现机制、核心内容、内容寿命、链接入口、站内转化、站外转化、典型商业化、主要指标、主要限制。

- [ ] **Step 2: 按统一14项结构编写核心平台档案**

分别编写YouTube、TikTok、Instagram。每个平台必须覆盖：

1. 平台定位和用户心智
2. 平台特性
3. 主要受众
4. 发现机制
5. 内容类型和原生语法
6. 内容对应的商业合作形式
7. 常规商业合作要求
8. 链接能力
9. 转化路径
10. 创作者合作和付费放大
11. 数据和指标定义
12. 产品、客户目标和达人适配
13. 风险、披露、版权和限制
14. 官方来源、核验日和适用市场

每个平台至少提供一个站内闭环、一个站外转化和一个长决策转化示例。

- [ ] **Step 3: 编写标准扩展平台档案**

用同一结构编写Facebook、X、Pinterest、Reddit、LinkedIn。不能把Reddit社区合作写成普通短视频商单，不能把LinkedIn线索获取写成消费品即时成交，不能把Pinterest写成即时爆量平台。

- [ ] **Step 4: 编写特殊场景平台档案**

用同一结构编写Snapchat、Twitch、Threads、Discord，并明确何时启用、何时不适用。Discord定位为自有社区、留存和客服协作，不使用通用红人播放量评分法。

- [ ] **Step 5: 建立内容类型—商业合作形式映射**

覆盖赠品、付费原生发布、Dedicated、Integration、UGC生产、联盟佣金、直播与站内电商、长期大使、付费放大、素材授权、活动与社区合作。每一项写清交付、修改、保留期、披露、链接、数据、授权、排他、取消和付款要求。

- [ ] **Step 6: 建立链接和转化路径矩阵**

每个平台逐项记录：链接位置、是否可点击、账号/地区/粉丝或广告资格、自然与付费差异、商品标签、UTM/折扣码/联盟追踪、落地页摩擦和更新日期。不得只写“可以”或“不可以”。

- [ ] **Step 7: 执行平台档案检查**

Run:

```powershell
$f='商务培训/02-主流社媒平台档案与商业化路径-v1.0.md'
rg -n '^## (YouTube|TikTok|Instagram|Facebook|X|Pinterest|Reddit|LinkedIn|Snapchat|Twitch|Threads|Discord)' $f
rg -n '主要受众|平台特性|内容类型|商业合作形式|常规商业合作要求|链接能力|转化路径|核验日期|适用市场' $f
rg -n '一定转化最高|一定最便宜|保证爆|全球统一可用|IGTV|Shorts最多60秒' $f
```

Expected: 12个平台及全部必填主题存在；最后一条命令无匹配。

- [ ] **Step 8: 提交平台档案**

```powershell
git add -- '商务培训/02-主流社媒平台档案与商业化路径-v1.0.md'
git commit --only -m 'docs: add social platform commercial playbook' -- '商务培训/02-主流社媒平台档案与商业化路径-v1.0.md'
```

---

### Task 3: 编写稳定营销基础培训手册

**Files:**
- Create: `商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md`

**Interfaces:**
- Consumes: 平台档案、当前SOP、两本内部手册。
- Produces: 五周课程的统一知识教材和案例答题框架。

- [ ] **Step 1: 编写客户生意与营销基础**

包含STP/ICP、购买场景、购买阻力、品牌阶段、客户旅程、认知—考虑—购买—复购漏斗，以及红人营销在品牌、内容、搜索、销售和用户洞察中的位置。

- [ ] **Step 2: 编写目标与指标树**

解释曝光、有效观看、互动、搜索、点击、加购、购买、复购的上下游关系；统一给出CPM、CPV、CPE、CTR、CPC、CVR、CPA、ROAS、ROI和贡献毛利公式，并为每个公式提供一个带答案的算例。

- [ ] **Step 3: 编写统一决策模型**

把“客户目标→市场受众→产品购买阻力→平台角色→达人类型→内容证据→商业形式→链接转化→指标归因→风险”写成主模型。配套至少两个反例，说明高曝光、互动、点击或ROAS为何不能独立代表成功。

- [ ] **Step 4: 编写合作与权利基础**

解释赠品、固定费、佣金、混合模式、UGC、广告放大、素材授权、排他和长期大使；明确自然发布权不等于素材使用权或付费投放权。

- [ ] **Step 5: 编写合规与承诺边界**

覆盖商业披露、健康/安全宣称、版权音乐、隐私、儿童、竞品排他和品牌安全。对美国市场的披露规则引用FTC官方资料；其他市场明确要求项目级复核。

- [ ] **Step 6: 链接动态平台档案**

平台数据、格式、链接和商业工具只做摘要，详细事实全部指向02平台档案，避免在两处维护冲突版本。

- [ ] **Step 7: 校验手册覆盖与公式**

Run:

```powershell
$f='商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md'
rg -n '客户旅程|购买阻力|品牌阶段|CPM|CPV|CPE|CTR|CPC|CVR|CPA|ROAS|ROI|贡献毛利|商业披露|素材授权|付费投放权' $f
rg -n '一定爆|保证ROI|所有产品|任何市场都适用' $f
```

Expected: 第一条覆盖全部知识点；第二条无未经批判说明的绝对承诺。

- [ ] **Step 8: 提交基础手册**

```powershell
git add -- '商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md'
git commit --only -m 'docs: add influencer marketing foundation handbook' -- '商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md'
```

---

### Task 4: 编写产品—平台—达人—内容案例库

**Files:**
- Create: `商务培训/03-产品平台达人内容匹配案例库-v1.0.md`

**Interfaces:**
- Consumes: 基础手册的决策模型、平台档案。
- Produces: 题库、Roleplay和产品方案训练使用的标准案例。

- [ ] **Step 1: 建立产品诊断卡**

字段固定为：市场、受众、客单价、决策周期、品牌阶段、购买阻力、可视化速度、解释深度、信任要求、合规风险、样品物流、销售渠道、主目标、预算、时间窗、已有数据。

- [ ] **Step 2: 编写8个重点行业案例**

分别覆盖3C、储能、智能家居、美妆、户外、出行/eBike、医疗健康、宠物。每个案例必须给出主平台、辅助平台、平台分工、达人原型、内容证据、链接、CTA、指标、预算假设、风险和替代方案。

- [ ] **Step 3: 添加反例与条件变化题**

每个行业至少添加一个改变条件后的不同答案，例如低价配件与高价主机、宠物玩具与宠物保健品、智能灯带与家庭安防、普通护肤与功效宣称产品。

- [ ] **Step 4: 添加统一10分评分标准**

购买阻力与变量2分、平台分工2分、达人及核验2分、内容证据和CTA2分、合规/物流/归因2分。只按行业选平台扣2分，只按粉丝量选达人或承诺ROI扣2分，漏掉医疗/安全/隐私红线则本题不合格。

- [ ] **Step 5: 校验案例覆盖**

Run:

```powershell
$f='商务培训/03-产品平台达人内容匹配案例库-v1.0.md'
rg -n '^## .*3C|^## .*储能|^## .*智能家居|^## .*美妆|^## .*户外|^## .*eBike|^## .*医疗|^## .*宠物' $f
rg -n '主平台|辅助平台|达人原型|内容证据|CTA|链接|指标|风险|替代方案' $f
```

Expected: 8行业全部存在，每个案例字段齐全。

- [ ] **Step 6: 提交案例库**

```powershell
git add -- '商务培训/03-产品平台达人内容匹配案例库-v1.0.md'
git commit --only -m 'docs: add product platform fit casebook' -- '商务培训/03-产品平台达人内容匹配案例库-v1.0.md'
```

---

### Task 5: 编写达人质量评估评分卡

**Files:**
- Create: `商务培训/04-达人质量评估评分卡-v1.0.md`

**Interfaces:**
- Consumes: 平台档案的指标定义和SOP达人门禁。
- Produces: 商务初筛表、运营复核输入和达人题库评分依据。

- [ ] **Step 1: 写硬门槛和一票否决项**

覆盖数据造假、身份与收款主体异常、披露拒绝、违规宣称、严重品牌安全、竞品排他、账号处罚、跑单和恶意删商单。

- [ ] **Step 2: 写100分评分标准**

按25/20/20/10/15/10权重，给每个子项提供0、1、3、5分锚点和需要的证据。总分等级设为：A 85—100、B 75—84、C 65—74、D低于65；C级只允许小额验证并配置替补。

- [ ] **Step 3: 写证据置信度和缺失处理**

使用H/M/L等级。关键后台数据缺失不自动判定造假，但高预算首单最高只能进入C级；拒绝提供正常可提供的证据必须升级人工复核。

- [ ] **Step 4: 写平台差异化指标**

YouTube区分长视频和Shorts；Instagram区分Reels、Feed和Stories；TikTok看中位播放、区间、留存、完播和单条受众；不同平台互动率必须注明分母。

- [ ] **Step 5: 写9步评估流程和3个算例**

流程从项目口径、批量初筛、量化预审、红旗扫描、短名单取证、人工审查、商业可靠性、评分决策到上线后回填。算例至少包括高分但排他冲突、粉丝大但数据异常、受众匹配且稳定的微型达人。

- [ ] **Step 6: 校验评分总额与红旗**

Run:

```powershell
$f='商务培训/04-达人质量评估评分卡-v1.0.md'
rg -n '25|20|10|15|100|一票否决|证据置信度|YouTube|Instagram|TikTok|互动率.*分母|运营.*复核' $f
```

Expected: 权重、等级、硬门槛、平台差异和复核边界全部出现。

- [ ] **Step 7: 提交评分卡**

```powershell
git add -- '商务培训/04-达人质量评估评分卡-v1.0.md'
git commit --only -m 'docs: add creator quality scorecard' -- '商务培训/04-达人质量评估评分卡-v1.0.md'
```

---

### Task 6: 编写知识题库、Roleplay与上岗认证

**Files:**
- Create: `商务培训/05-商务新人Roleplay与知识题库-v2.0.md`
- Create: `商务培训/06-五周培养与上岗认证-v1.0.md`

**Interfaces:**
- Consumes: 基础手册、平台档案、案例库和达人评分卡。
- Produces: 培训实施、考官评分、补考和独立上岗证据。

- [ ] **Step 1: 编写五周课程表**

按设计规格的五周结构编写每周学习目标、课程、阅读、案例、作业、陪访、Roleplay、评分和验收证据。每周明确“学—判—练—考”四步。

- [ ] **Step 2: 编写理论与案例题库**

至少40题：平台12题、产品适配8题、达人判断8题、指标归因6题、合规与授权6题。每题提供答案、评分点、常见错误和引用章节。

- [ ] **Step 3: 编写6个Roleplay场景**

覆盖储能、eBike、美妆、智能家居、医疗健康和宠物。每个场景包含客户背景、显性需求、隐性阻力、必须追问、平台和达人判断、风险、考官问题、优秀回答锚点和失败红线。

- [ ] **Step 4: 校准原Roleplay旧口径**

保留原版文件，v2.0中纠正固定平台预算比例、效果付费等同于不成功不收费、固定达人互动率、固定平台价格和绝对化转化判断。

- [ ] **Step 5: 建立认证和权限门禁**

理论≥85、红线100%、平台案例≥80、达人实操≥85、Roleplay≥80。新人独立上岗前完成至少2次跟访、2次主管陪同主导、1次报价或交接演练；未通过者不得独立报价、承诺或推进关键门禁。

- [ ] **Step 6: 建立补考与签收规则**

记录人员、岗位、教材版本、考试版本、成绩、红线题、考官、日期、改进项、补考和权限状态。阅读确认不能替代考试认证。

- [ ] **Step 7: 校验题量和门槛**

Run:

```powershell
rg -n '^### 题目|^### 场景' 商务培训/05-商务新人Roleplay与知识题库-v2.0.md
rg -n '理论.*85|红线.*100|平台案例.*80|达人实操.*85|Roleplay.*80|2次跟访|2次主管陪同' 商务培训/06-五周培养与上岗认证-v1.0.md
```

Expected: 至少40题、6个Roleplay场景，认证和受监督权限规则完整。

- [ ] **Step 8: 提交题库与认证文件**

```powershell
git add -- '商务培训/05-商务新人Roleplay与知识题库-v2.0.md' '商务培训/06-五周培养与上岗认证-v1.0.md'
git commit --only -m 'docs: add sales training certification pack' -- '商务培训/05-商务新人Roleplay与知识题库-v2.0.md' '商务培训/06-五周培养与上岗认证-v1.0.md'
```

---

### Task 7: 生成SOP v2.1并联动版本记录

**Files:**
- Create: `商务团队客户全生命周期与日常作业SOP-v2.1.md`
- Modify: `CHANGELOG.md`
- Modify: `商务培训/00-培训资料索引与版本说明.md`

**Interfaces:**
- Consumes: 全套培训文件和v2.0 SOP。
- Produces: 受控试运行流程入口和可审计版本记录。

- [ ] **Step 1: 复制v2.0为v2.1并保留原版**

使用安全复制或补丁创建v2.1；不得覆盖v2.0。更新标题、版本、修订日期和修订记录，状态继续保持“受控试运行版”，直到系统字段、审批、Owner和培训认证全部完成。

- [ ] **Step 2: 重写培训章节**

将原五周表更新为“营销基础—平台—产品与达人—客户方案—综合闭环”，链接01至06培训文件，并写明各周合格标准、未通过权限限制和商务/运营边界。

- [ ] **Step 3: 更新正式生效门禁**

把“阅读确认”改为角色培训、理论考试、实操、Roleplay和实名版本签收。流程正式生效不等于薪酬和提成制度生效。

- [ ] **Step 4: 追加CHANGELOG记录**

先读取当前未提交内容，使用最小补丁追加培训体系v1.0和SOP v2.1记录，不重排或覆盖其他版本条目。

- [ ] **Step 5: 校验版本与链接**

Run:

```powershell
rg -n 'v2.1|商务培训/01-|商务培训/02-|商务培训/03-|商务培训/04-|商务培训/05-|商务培训/06-|理论考试|Roleplay|运营.*最终.*复核' 商务团队客户全生命周期与日常作业SOP-v2.1.md
Test-Path -LiteralPath '商务团队客户全生命周期与日常作业SOP-v2.0.md'
```

Expected: v2.1引用完整，v2.0仍存在且内容未改变。

- [ ] **Step 6: 提交集成文件**

```powershell
git add -- '商务团队客户全生命周期与日常作业SOP-v2.1.md' '商务培训/00-培训资料索引与版本说明.md'
git commit --only -m 'docs: integrate sales training into sop v2.1' -- '商务团队客户全生命周期与日常作业SOP-v2.1.md' '商务培训/00-培训资料索引与版本说明.md'
```

`CHANGELOG.md`已有用户工作时，先展示最小差异并单独提交该文件，避免带入其他路径。

---

### Task 8: 全套内容审校与事实复核

**Files:**
- Modify: `商务培训/00-培训资料索引与版本说明.md`
- Modify: `商务培训/01-商务新人海外红人营销基础培训手册-v1.0.md`
- Modify: `商务培训/02-主流社媒平台档案与商业化路径-v1.0.md`
- Modify: `商务培训/03-产品平台达人内容匹配案例库-v1.0.md`
- Modify: `商务培训/04-达人质量评估评分卡-v1.0.md`
- Modify: `商务培训/05-商务新人Roleplay与知识题库-v2.0.md`
- Modify: `商务培训/06-五周培养与上岗认证-v1.0.md`
- Modify: `商务培训/07-平台事实与来源维护台账-v1.0.md`
- Modify: `商务团队客户全生命周期与日常作业SOP-v2.1.md`

**Interfaces:**
- Consumes: Tasks 1—7全部产物。
- Produces: 可发布的受控培训包。

- [ ] **Step 1: 做来源一致性审查**

逐条核对平台受众、格式、链接、商店、广告授权和披露结论是否有官方来源；删除无法确认的具体数字，或明确标记为内部事实、经验判断或项目假设。

- [ ] **Step 2: 做交叉文件一致性审查**

检查平台名称、指标公式、达人权重、分档、考试门槛、五周课程和商务/运营责任在所有文件中一致。

- [ ] **Step 3: 做语言和承诺风险审查**

删除或改写“保证、一定、最高、最低、所有、全球都可用”等无边界表述；把案例收益标为教学模拟或脱敏历史数据，并注明证据状态。

- [ ] **Step 4: 做Markdown结构检查**

严格验证UTF-8、标题重复、表格列数、代码围栏和本地链接。检查命令：

```powershell
$files=Get-ChildItem -LiteralPath '商务培训' -Filter '*.md'; $files+=Get-Item -LiteralPath '商务团队客户全生命周期与日常作业SOP-v2.1.md'; foreach($f in $files){$enc=New-Object System.Text.UTF8Encoding($false,$true); $null=$enc.GetString([System.IO.File]::ReadAllBytes($f.FullName)); $raw=Get-Content -LiteralPath $f.FullName -Raw -Encoding utf8; if(([regex]::Matches($raw,'```').Count % 2)-ne 0){throw "Unbalanced fences: $($f.FullName)"}}
```

Expected: 无编码异常、无不平衡围栏；表格和链接检查无错误。

- [ ] **Step 5: 做业务复核**

分别从商务主管、运营负责人和培训考官视角检查：新人能否找到答案、能否做条件式判断、能否识别红线、评分是否可复现、资料是否存在相互冲突。

- [ ] **Step 6: 提交审校修订**

只提交本培训包和SOP v2.1实际发生变化的文件，提交信息：

```powershell
git commit --only -m 'docs: validate sales training release candidate' -- '商务培训' '商务团队客户全生命周期与日常作业SOP-v2.1.md'
```

---

### Task 9: 归档、哈希验证与发布交接

**Files:**
- Archive: `D:/主盘/图灵集市/内部知识文件/商务培训/`
- Archive: `D:/主盘/图灵集市/红人营销-执行/内部知识文件/商务团队客户全生命周期与日常作业SOP-v2.1.md`

**Interfaces:**
- Consumes: 通过Task 8审校的发布候选文件。
- Produces: 工作区、Obsidian和Git三处可追溯版本。

- [ ] **Step 1: 检查归档目标**

解析并核对两个归档目录位于 `D:/主盘/图灵集市/` 内。若 `内部知识文件/商务培训` 不存在，可创建该明确命名目录；如发现同名文件，先比较版本和哈希，不静默覆盖。

- [ ] **Step 2: 复制培训包和SOP**

保留工作区源文件，复制全部8份培训文件和SOP v2.1到指定Obsidian目录。旧版保持只读历史，不删除。

- [ ] **Step 3: 验证哈希和数量**

Run:

```powershell
$src=Get-ChildItem -LiteralPath '商务培训' -Filter '*.md' | Sort-Object Name
$dst=Get-ChildItem -LiteralPath 'D:\主盘\图灵集市\内部知识文件\商务培训' -Filter '*.md' | Sort-Object Name
if($src.Count -ne 8){throw "Expected 8 training files, got $($src.Count)"}
foreach($s in $src){$d=Join-Path 'D:\主盘\图灵集市\内部知识文件\商务培训' $s.Name; if(-not(Test-Path -LiteralPath $d)){throw "Missing archive: $d"}; if((Get-FileHash -Algorithm SHA256 -LiteralPath $s.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $d).Hash){throw "Hash mismatch: $($s.Name)"}}
```

Expected: 8份培训文件全部存在且源/归档SHA256一致；SOP v2.1另行比对一致。

- [ ] **Step 4: 验证Git范围并推送当前分支**

确认所有提交只包含培训包、SOP v2.1、设计规格、实施计划和经最小补丁更新的CHANGELOG；不得提交工作区其他修改。随后推送当前分支：

```powershell
git log --oneline --name-only -10
git push origin codex/phase-2-customer-pipeline
```

- [ ] **Step 5: 完成交付报告**

报告工作区文件、Obsidian归档路径、Git提交、哈希验证、受控试运行状态、仍需业务Owner执行的平台季度维护和团队认证动作。
