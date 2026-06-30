(function (window, document) {
  'use strict';

  const STORAGE_KEY = 'tm_demands';
  const CURRENT_KEY = 'tm_current_demand_id';

  const state = {
    demands: [],
    currentId: '',
    prefillBrand: ''
  };

  function load() {
    state.demands = Utils.getStorage(STORAGE_KEY, []);
    state.currentId = window.localStorage.getItem(CURRENT_KEY) || state.demands[0]?.id || '';
  }

  function save() {
    Utils.setStorage(STORAGE_KEY, state.demands);
    if (state.currentId) window.localStorage.setItem(CURRENT_KEY, state.currentId);
  }

  function currentDemand() {
    return state.demands.find((item) => item.id === state.currentId) || null;
  }

  function blankDemand() {
    return {
      id: '',
      brand: state.prefillBrand || '',
      company: '',
      industry: '',
      market: '北美',
      product: '',
      objective: '',
      audience: '',
      platforms: 'TikTok, Instagram, YouTube',
      budget: '',
      timeline: '',
      deliverables: '短视频测评, 开箱种草, 达人授权素材',
      brief: '',
      references: '',
      status: 'intake',
      proposalDraft: '',
      confirmedProposal: '',
      knowledgeUsed: [],
      createdAt: Utils.today(),
      updatedAt: Utils.today()
    };
  }

  function upsertDemand(next) {
    const index = state.demands.findIndex((item) => item.id === next.id);
    if (index >= 0) state.demands[index] = next;
    else state.demands.unshift(next);
    state.currentId = next.id;
    save();
    if (window.M0?.addCustomerFromDemand) {
      window.M0.addCustomerFromDemand(next);
    }
    return next;
  }

  function readForm() {
    const existing = currentDemand() || blankDemand();
    return {
      ...existing,
      id: existing.id || Utils.uid('demand'),
      brand: DOM.value('m3Brand'),
      company: DOM.value('m3Company'),
      industry: DOM.value('m3Industry'),
      market: DOM.value('m3Market'),
      product: DOM.value('m3Product'),
      objective: DOM.value('m3Objective'),
      audience: DOM.value('m3Audience'),
      platforms: DOM.value('m3Platforms'),
      budget: DOM.value('m3Budget'),
      timeline: DOM.value('m3Timeline'),
      deliverables: DOM.value('m3Deliverables'),
      brief: DOM.value('m3Brief'),
      references: DOM.value('m3References'),
      updatedAt: Utils.today()
    };
  }

  function validateDemand(demand) {
    if (!demand.brand) return '请填写品牌名';
    if (!demand.objective) return '请填写本次营销目标';
    if (!demand.product && !demand.brief) return '请填写产品/服务或补充需求';
    return '';
  }

  function findKnowledge(demand) {
    const kb = Utils.getStorage('tm_knowledge_base', []);
    const terms = [
      demand.brand,
      demand.industry,
      demand.market,
      demand.product,
      ...Utils.splitList(demand.objective).slice(0, 3)
    ].map((item) => String(item || '').trim().toLowerCase()).filter((item) => item.length >= 2);

    return kb
      .map((entry) => {
        const haystack = `${entry.title || ''} ${entry.content || ''} ${(entry.tags || []).join(' ')}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { ...entry, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  function marketAdvice(demand) {
    const market = demand.market || '';
    if (market.includes('北美')) return '以 TikTok/Instagram 种草和 YouTube 深度测评承接转化，重点观察 Amazon、独立站和 TikTok Shop 的转化链路。';
    if (market.includes('欧洲')) return '以本地语言达人和合规表达为优先，强调产品可信度、测评透明度和多国家素材复用。';
    if (market.includes('东南亚')) return '优先选择高互动短视频达人和直播/联盟结合打法，预算拆分应更细，便于快速测试。';
    if (market.includes('中东')) return '内容需要兼顾本地文化语境和高质感视觉表达，建议用头腰部达人建立信任。';
    return '先用内容测试建立可复制素材，再扩大到更高预算的达人组合。';
  }

  function buildDraft(demand, knowledgeMatches) {
    const platforms = Utils.splitList(demand.platforms);
    const deliverables = Utils.splitList(demand.deliverables);
    const budget = demand.budget ? `¥${Number(demand.budget || 0).toLocaleString()}` : '待确认';
    const knowledgeText = knowledgeMatches.length
      ? knowledgeMatches.map((item) => `- ${item.title}: ${Utils.compactText(item.content, 120)}`).join('\n')
      : '- 暂无强匹配知识库条目，本次先基于需求信息生成初版策略。';

    return `## 1. 项目背景与目标
- 品牌/客户：${demand.brand}${demand.company ? `（${demand.company}）` : ''}
- 产品/服务：${demand.product || '待补充'}
- 核心目标：${demand.objective}
- 目标市场：${demand.market || '待确认'}；预算：${budget}；周期：${demand.timeline || '待确认'}

## 2. 需求诊断
- 当前需求重点是${demand.objective}，应先把目标拆成曝光、内容资产、互动线索和转化四类指标。
- ${marketAdvice(demand)}
- 目标受众：${demand.audience || '需继续补充年龄、国家、兴趣和购买场景。'}

## 3. 内容策略
- 内容主线一：痛点场景切入，突出产品真实使用前后的差异。
- 内容主线二：达人第一视角测评，保留真实体验、价格锚点和购买路径。
- 内容主线三：可复用素材资产，服务广告投放、落地页和销售跟进。
- 参考要求：${demand.references || '暂无指定竞品或内容参考。'}

## 4. 达人组合建议
- 平台优先级：${platforms.join(' / ') || '待确认'}。
- 建议配置：20% 头部建立信任，50% 腰部形成稳定内容产出，30% 长尾达人做快速测试。
- 交付物：${deliverables.join(' / ') || '待确认'}。

## 5. 执行排期
- 第 1 周：需求确认、竞品与达人画像、脚本方向确定。
- 第 2-3 周：达人筛选、报价确认、样品寄送和内容 brief 对齐。
- 第 4-5 周：内容发布、数据监控、素材授权整理。
- 第 6 周：复盘报告、二次投放建议和下一轮预算分配。

## 6. KPI 与验收
- 曝光指标：覆盖人数、播放量、互动率、内容完播率。
- 转化指标：落地页点击、加购/询盘、优惠码/联盟链接归因。
- 过程指标：达人回复率、内容按时交付率、授权素材数量。

## 7. 知识库参考
${knowledgeText}

## 8. 下一步确认事项
- 确认预算上限、投放国家、核心产品卖点和禁用表达。
- 确认是否需要把本方案继续拆成达人 brief、报价表和执行甘特图。
- 人工修改本草稿后点击“确认方案”，再导出 PPT 或 HTML。`;
  }

  function renderDemandList() {
    if (!state.demands.length) {
      return '<div class="empty-state"><p>暂无需求，填写左侧表单后保存。</p></div>';
    }
    return state.demands.map((item) => `
      <div class="kb-entry ${item.id === state.currentId ? 'active' : ''}" onclick="M3.selectDemand('${item.id}')">
        <div class="title">${Utils.escapeHtml(item.brand || '未命名需求')}</div>
        <div class="meta">
          <span>${statusLabel(item.status)}</span>
          <span>${Utils.formatDate(item.updatedAt)}</span>
          <span>${Utils.escapeHtml(item.market || '-')}</span>
        </div>
        <div class="preview">${Utils.escapeHtml(Utils.compactText(item.objective || item.brief || '暂无目标', 72))}</div>
      </div>
    `).join('');
  }

  function statusLabel(status) {
    return {
      intake: '需求接入',
      draft: '草稿待确认',
      confirmed: '已确认方案'
    }[status] || status || '需求接入';
  }

  function currentOrBlank() {
    return currentDemand() || blankDemand();
  }

  function render() {
    const demand = currentOrBlank();
    DOM.setHtml('m3Content', `
      <div class="m3-layout">
        <div class="m3-section">
          <h3>需求接入</h3>
          <input type="hidden" id="m3DemandId" value="${Utils.escapeHtml(demand.id || '')}">
          <div class="form-row">
            <div class="form-group"><label>品牌名 *</label><input id="m3Brand" value="${Utils.escapeHtml(demand.brand || '')}" placeholder="例如 Aurora Beauty"></div>
            <div class="form-group"><label>公司/客户</label><input id="m3Company" value="${Utils.escapeHtml(demand.company || '')}" placeholder="公司主体或联系人"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>行业</label><input id="m3Industry" value="${Utils.escapeHtml(demand.industry || '')}" placeholder="美妆、3C、家居、母婴等"></div>
            <div class="form-group"><label>目标市场</label>
              <select id="m3Market">
                ${['北美', '欧洲', '东南亚', '中东', '日本', '韩国', '全球'].map((item) => `<option value="${item}" ${demand.market === item ? 'selected' : ''}>${item}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>产品/服务 *</label><input id="m3Product" value="${Utils.escapeHtml(demand.product || '')}" placeholder="主推产品、链接或服务说明"></div>
          <div class="form-group"><label>本次营销目标 *</label><textarea id="m3Objective" placeholder="例如新品上市曝光、TikTok Shop 引流、亚马逊站外测评等">${Utils.escapeHtml(demand.objective || '')}</textarea></div>
          <div class="form-row">
            <div class="form-group"><label>目标受众</label><textarea id="m3Audience" placeholder="国家、年龄、兴趣、消费场景">${Utils.escapeHtml(demand.audience || '')}</textarea></div>
            <div class="form-group"><label>投放平台</label><textarea id="m3Platforms">${Utils.escapeHtml(demand.platforms || '')}</textarea></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>预算</label><input id="m3Budget" type="number" min="0" value="${Utils.escapeHtml(demand.budget || '')}" placeholder="人民币预算"></div>
            <div class="form-group"><label>执行周期</label><input id="m3Timeline" value="${Utils.escapeHtml(demand.timeline || '')}" placeholder="例如 6 周 / Q3"></div>
          </div>
          <div class="form-group"><label>交付物</label><textarea id="m3Deliverables">${Utils.escapeHtml(demand.deliverables || '')}</textarea></div>
          <div class="form-group"><label>补充需求</label><textarea id="m3Brief" style="min-height:88px" placeholder="粘贴客户原始需求、邮件、会议纪要或限制条件">${Utils.escapeHtml(demand.brief || '')}</textarea></div>
          <div class="form-group"><label>竞品/参考链接</label><textarea id="m3References">${Utils.escapeHtml(demand.references || '')}</textarea></div>
          <div class="m3-upload-area" onclick="M3.openFilePicker()" ondragover="M3.onDragOver(event)" ondragleave="M3.onDragLeave(event)" ondrop="M3.onDrop(event)">
            <div class="icon">+</div>
            <div class="text">导入需求文本</div>
            <div class="sub">支持 .txt/.md 文件，内容会追加到补充需求</div>
          </div>
          <input type="file" id="m3FileInput" class="hidden" accept=".txt,.md,text/plain,text/markdown" onchange="M3.handleFile(this.files[0])">
          <div class="m3-actions">
            <button class="btn btn-outline" onclick="M3.newDemand()">新需求</button>
            <button class="btn btn-primary" onclick="M3.saveDemand()">保存需求</button>
            <button class="btn btn-success" onclick="M3.generateDraft()">生成AI草稿</button>
          </div>
        </div>

        <div class="m3-section">
          <h3>方案草稿与生成</h3>
          <div class="m3-analysis-summary">
            <div class="label">当前状态</div>
            ${statusLabel(demand.status)} · ${demand.brand ? Utils.escapeHtml(demand.brand) : '未选择需求'}
            <div style="margin-top:8px;color:var(--gray-500)">流程：需求接入 → AI草稿 → 人工修改确认 → 导出 PPT/HTML。</div>
          </div>
          <textarea id="m3ProposalEditor" class="m3-editable" placeholder="点击“生成AI草稿”后，可在这里人工修改方案内容。">${Utils.escapeHtml(demand.confirmedProposal || demand.proposalDraft || '')}</textarea>
          <div class="m3-file-info">
            ${renderKnowledgeInfo(demand)}
          </div>
          <div class="m3-actions">
            <button class="btn btn-primary" onclick="M3.confirmProposal()">确认方案</button>
            <button class="btn btn-success" onclick="M3.exportPPT()">导出PPT</button>
            <button class="btn btn-outline" onclick="M3.exportHTML()">导出HTML</button>
            <button class="btn btn-outline" onclick="M3.copyProposal()">复制方案</button>
          </div>
          <h3 style="margin-top:24px">历史需求</h3>
          <div id="m3DemandList">${renderDemandList()}</div>
        </div>
      </div>
    `);
  }

  function renderKnowledgeInfo(demand) {
    const used = demand.knowledgeUsed || [];
    if (!used.length) return '<span>知识库参考：尚未生成或暂无匹配条目</span>';
    return `<span>知识库参考：${used.map((item) => Utils.escapeHtml(item.title)).join(' / ')}</span>`;
  }

  function makeFileName(demand, ext) {
    const brand = (demand.brand || 'TuringMarket').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
    return `${brand}-influencer-proposal-${Utils.today()}.${ext}`;
  }

  function parseSections(text) {
    const lines = String(text || '').split(/\r?\n/);
    const sections = [];
    let current = null;

    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const heading = line.match(/^#{1,3}\s*(.+)$/);
      if (heading) {
        current = { title: heading[1].replace(/^\d+\.\s*/, ''), bullets: [] };
        sections.push(current);
        return;
      }
      if (!current) {
        current = { title: '方案摘要', bullets: [] };
        sections.push(current);
      }
      current.bullets.push(line.replace(/^[-*]\s*/, ''));
    });

    return sections.length ? sections : [{ title: '方案摘要', bullets: ['请先生成或填写方案内容。'] }];
  }

  function addFooter(slide, demand, page) {
    slide.addText('TuringMarket CRM', { x: 0.55, y: 7.08, w: 3, h: 0.2, fontFace: 'Microsoft YaHei', fontSize: 8, color: '7c8490' });
    slide.addText(`${demand.brand || ''} Proposal · ${page}`, { x: 9.3, y: 7.08, w: 3.4, h: 0.2, align: 'right', fontFace: 'Microsoft YaHei', fontSize: 8, color: '7c8490' });
  }

  function addSectionSlide(pptx, demand, section, index) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.22, fill: { color: '4F6EF7' }, line: { color: '4F6EF7' } });
    slide.addText(section.title, { x: 0.65, y: 0.55, w: 11.7, h: 0.45, fontFace: 'Microsoft YaHei', fontSize: 22, bold: true, color: '111827' });
    const bullets = section.bullets.slice(0, 7);
    slide.addText(bullets.map((item) => `• ${item}`).join('\n'), {
      x: 0.85,
      y: 1.35,
      w: 11.8,
      h: 5.15,
      fontFace: 'Microsoft YaHei',
      fontSize: 15,
      color: '374151',
      breakLine: false,
      fit: 'shrink',
      valign: 'top'
    });
    addFooter(slide, demand, index + 1);
  }

  function buildHtmlProposal(demand, text) {
    const sections = parseSections(text);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${Utils.escapeHtml(demand.brand)} Influencer Proposal</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;margin:0;background:#f3f4f6;color:#111827;line-height:1.6}
.cover{background:#4f6ef7;color:#fff;padding:72px 8vw 64px}
.cover h1{font-size:42px;margin:0 0 12px}
.cover p{font-size:18px;margin:0;color:#e9edff}
main{max-width:980px;margin:32px auto;padding:0 20px 48px}
section{background:#fff;border-radius:8px;padding:28px 32px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h2{font-size:24px;margin:0 0 16px;color:#111827}
li{margin:8px 0}
.meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:24px;color:#e9edff}
.meta span{border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:4px 12px}
</style>
</head>
<body>
<div class="cover">
  <h1>${Utils.escapeHtml(demand.brand)} 红人营销方案</h1>
  <p>TuringMarket CRM · ${Utils.today()}</p>
  <div class="meta">
    <span>${Utils.escapeHtml(demand.market || '目标市场待确认')}</span>
    <span>${demand.budget ? `预算 ¥${Number(demand.budget).toLocaleString()}` : '预算待确认'}</span>
    <span>${Utils.escapeHtml(demand.timeline || '周期待确认')}</span>
  </div>
</div>
<main>
${sections.map((section) => `
  <section>
    <h2>${Utils.escapeHtml(section.title)}</h2>
    <ul>${section.bullets.map((item) => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul>
  </section>
`).join('')}
</main>
</body>
</html>`;
  }

  const M3 = {
    switchToM3(prefillBrand) {
      state.prefillBrand = prefillBrand || '';
      load();
      if (prefillBrand) {
        const match = state.demands.find((item) => item.brand.toLowerCase() === prefillBrand.toLowerCase());
        state.currentId = match?.id || '';
      }
      DOM.showModule('m3Container', 'm3');
      render();
    },

    newDemand() {
      state.currentId = '';
      state.prefillBrand = '';
      render();
    },

    selectDemand(id) {
      state.currentId = id;
      save();
      render();
    },

    saveDemand() {
      const demand = readForm();
      const validation = validateDemand(demand);
      if (validation) {
        Utils.toast(validation, 'warning');
        return null;
      }
      demand.status = demand.status || 'intake';
      const saved = upsertDemand(demand);
      render();
      Utils.toast('需求已保存，并同步到客户线索', 'success');
      return saved;
    },

    generateDraft() {
      const demand = readForm();
      const validation = validateDemand(demand);
      if (validation) {
        Utils.toast(validation, 'warning');
        return;
      }
      const matches = findKnowledge(demand);
      demand.knowledgeUsed = matches.map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category
      }));
      demand.proposalDraft = buildDraft(demand, matches);
      demand.status = 'draft';
      demand.updatedAt = Utils.today();
      upsertDemand(demand);
      render();
      Utils.toast('AI草稿已生成，请人工修改并确认', 'success');
    },

    confirmProposal() {
      const demand = readForm();
      const text = DOM.value('m3ProposalEditor');
      const validation = validateDemand(demand);
      if (validation) {
        Utils.toast(validation, 'warning');
        return;
      }
      if (!text) {
        Utils.toast('请先生成或填写方案草稿', 'warning');
        return;
      }
      demand.confirmedProposal = text;
      demand.proposalDraft = demand.proposalDraft || text;
      demand.status = 'confirmed';
      demand.updatedAt = Utils.today();
      upsertDemand(demand);

      if (window.KB?.addEntry) {
        window.KB.addEntry({
          category: 'proposal',
          title: `${demand.brand} 红人营销方案`,
          content: text,
          tags: [demand.brand, demand.market, demand.industry, 'proposal'].filter(Boolean),
          source: 'M3需求方案'
        });
      }

      render();
      Utils.toast('方案已确认，可以导出 PPT/HTML', 'success');
    },

    async exportPPT() {
      const demand = currentDemand();
      const text = DOM.value('m3ProposalEditor') || demand?.confirmedProposal || '';
      if (!demand || demand.status !== 'confirmed') {
        Utils.toast('请先确认方案，再导出PPT', 'warning');
        return;
      }
      const PptxCtor = window.pptxgen || window.PptxGenJS;
      if (!PptxCtor) {
        Utils.toast('PPTX 库未加载，请确认网络可访问 cdn.jsdelivr.net', 'error');
        return;
      }

      try {
        const pptx = new PptxCtor();
        pptx.layout = 'LAYOUT_WIDE';
        pptx.author = 'TuringMarket CRM';
        pptx.company = 'TuringMarket';
        pptx.subject = `${demand.brand} influencer marketing proposal`;
        pptx.title = `${demand.brand} 红人营销方案`;
        pptx.lang = 'zh-CN';

        const cover = pptx.addSlide();
        cover.background = { color: '4F6EF7' };
        cover.addText(`${demand.brand}\n红人营销方案`, { x: 0.8, y: 1.15, w: 9.2, h: 1.6, fontFace: 'Microsoft YaHei', fontSize: 34, bold: true, color: 'FFFFFF', breakLine: false, fit: 'shrink' });
        cover.addText(`目标市场：${demand.market || '待确认'}\n预算：${demand.budget ? `¥${Number(demand.budget).toLocaleString()}` : '待确认'}\n周期：${demand.timeline || '待确认'}`, { x: 0.9, y: 3.25, w: 5.8, h: 1.2, fontFace: 'Microsoft YaHei', fontSize: 15, color: 'E9EDFF', breakLine: false });
        cover.addText(`TuringMarket CRM · ${Utils.today()}`, { x: 0.9, y: 6.62, w: 4.8, h: 0.3, fontFace: 'Microsoft YaHei', fontSize: 11, color: 'E9EDFF' });
        cover.addShape(pptx.ShapeType.roundRect, { x: 8.55, y: 1.2, w: 3.85, h: 4.9, rectRadius: 0.1, fill: { color: 'FFFFFF', transparency: 8 }, line: { color: 'FFFFFF', transparency: 100 } });
        cover.addText('Proposal\nDeck', { x: 9.05, y: 2.45, w: 2.85, h: 1.1, fontFace: 'Microsoft YaHei', fontSize: 27, bold: true, color: '4F6EF7', align: 'center' });

        parseSections(text).slice(0, 8).forEach((section, index) => addSectionSlide(pptx, demand, section, index));

        await pptx.writeFile({ fileName: makeFileName(demand, 'pptx') });
        Utils.toast('PPT 已生成', 'success');
      } catch (error) {
        console.error(error);
        Utils.toast('PPT 生成失败，请查看控制台错误', 'error');
      }
    },

    exportHTML() {
      const demand = currentDemand();
      const text = DOM.value('m3ProposalEditor') || demand?.confirmedProposal || '';
      if (!demand || demand.status !== 'confirmed') {
        Utils.toast('请先确认方案，再导出HTML', 'warning');
        return;
      }
      Utils.downloadBlob(makeFileName(demand, 'html'), buildHtmlProposal(demand, text), 'text/html;charset=utf-8');
      Utils.toast('HTML 方案已生成', 'success');
    },

    copyProposal() {
      const text = DOM.value('m3ProposalEditor');
      if (!text) {
        Utils.toast('暂无方案内容可复制', 'warning');
        return;
      }
      navigator.clipboard?.writeText(text).then(() => {
        Utils.toast('方案已复制', 'success');
      }).catch(() => {
        Utils.toast('浏览器不允许自动复制，请手动选择文本复制', 'warning');
      });
    },

    openFilePicker() {
      Utils.qs('#m3FileInput')?.click();
    },

    onDragOver(event) {
      event.preventDefault();
      event.currentTarget.classList.add('dragover');
    },

    onDragLeave(event) {
      event.currentTarget.classList.remove('dragover');
    },

    onDrop(event) {
      event.preventDefault();
      event.currentTarget.classList.remove('dragover');
      const file = event.dataTransfer.files[0];
      M3.handleFile(file);
    },

    handleFile(file) {
      if (!file) return;
      if (!/\.(txt|md)$/i.test(file.name) && !file.type.includes('text')) {
        Utils.toast('当前版本只支持导入文本文件', 'warning');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const brief = Utils.qs('#m3Brief');
        if (brief) {
          brief.value = `${brief.value ? `${brief.value}\n\n` : ''}${reader.result}`;
        }
        Utils.toast(`已导入 ${file.name}`, 'success');
      };
      reader.readAsText(file, 'utf-8');
    }
  };

  window.M3 = M3;
})(window, document);
