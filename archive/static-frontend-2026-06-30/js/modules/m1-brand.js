(function (window, document) {
  'use strict';

  const brands = [
    { name: 'Aurora Beauty', industry: '美妆', market: '北美', score: 86, note: '适合短视频种草、测评和素材授权。' },
    { name: 'NovaCharge', industry: '3C', market: '欧洲', score: 78, note: '适合 YouTube 深度测评和 Amazon 站外引流。' },
    { name: 'HomeEase', industry: '家居', market: '东南亚', score: 72, note: '适合生活方式达人和场景化短视频。' }
  ];

  function render(list) {
    DOM.setHtml('m1StatsRow', `
      <div class="stat-card accent"><div class="label">品牌样本</div><div class="value">${brands.length}</div><div class="sub">静态演示数据</div></div>
      <div class="stat-card success"><div class="label">可归档</div><div class="value">是</div><div class="sub">搜索结果可进入知识库</div></div>
    `);
    DOM.setHtml('m1IndustryFilters', ['全部', '美妆', '3C', '家居'].map((item) => `<button class="btn btn-outline btn-sm" onclick="M1.filter('${item}')">${item}</button>`).join(''));
    DOM.setHtml('m1BrandList', list.map((brand) => `
      <div class="m1-brand-card" onclick="M1.openSidebar('${brand.name}')">
        <div class="m1-brand-header">
          <div><h4>${Utils.escapeHtml(brand.name)}</h4><div class="m1-brand-meta">${brand.industry} · ${brand.market}</div></div>
          <span class="stage-badge stage-analysis">${brand.score}</span>
        </div>
        <p style="margin-top:8px;color:var(--gray-500)">${Utils.escapeHtml(brand.note)}</p>
      </div>
    `).join(''));
  }

  const M1 = {
    switchToBrandHub() {
      DOM.showModule('m1Container', 'brands');
      render(brands);
      const input = Utils.qs('#m1SearchInput');
      if (input && !input.dataset.bound) {
        input.dataset.bound = '1';
        input.addEventListener('input', () => {
          const q = input.value.toLowerCase();
          render(brands.filter((brand) => `${brand.name} ${brand.industry} ${brand.market}`.toLowerCase().includes(q)));
        });
      }
    },

    filter(industry) {
      render(industry === '全部' ? brands : brands.filter((brand) => brand.industry === industry));
    },

    openSidebar(name) {
      const brand = brands.find((item) => item.name === name);
      if (!brand) return;
      DOM.setHtml('m1SidebarTitle', brand.name);
      DOM.setHtml('m1SidebarBody', `
        <div class="detail-grid">
          <div class="detail-item"><div class="lbl">行业</div><div class="val">${brand.industry}</div></div>
          <div class="detail-item"><div class="lbl">市场</div><div class="val">${brand.market}</div></div>
          <div class="detail-item"><div class="lbl">匹配分</div><div class="val">${brand.score}</div></div>
        </div>
        <div class="m3-analysis-summary">${Utils.escapeHtml(brand.note)}</div>
        <div class="m3-actions">
          <button class="btn btn-primary" onclick="M3.switchToM3('${brand.name}')">生成需求方案</button>
          <button class="btn btn-outline" onclick="M1.archive('${brand.name}')">归档知识库</button>
        </div>
      `);
      Utils.qs('#m1SidebarOverlay')?.classList.add('open');
      Utils.qs('#m1Sidebar')?.classList.add('open');
    },

    archive(name) {
      const brand = brands.find((item) => item.name === name);
      if (!brand) return;
      window.KB?.addEntry({
        category: 'customer',
        title: `${brand.name} 品牌洞察`,
        content: `${brand.industry} / ${brand.market}。${brand.note}`,
        tags: [brand.name, brand.industry, brand.market],
        source: 'M1品牌智库'
      });
      Utils.toast('品牌信息已归档到知识库', 'success');
    },

    closeSidebar() {
      Utils.qs('#m1SidebarOverlay')?.classList.remove('open');
      Utils.qs('#m1Sidebar')?.classList.remove('open');
    },

    closeSocialPanel() {
      Utils.qs('#m1SocialPanel')?.classList.add('hidden');
    },

    closeSimilarPanel() {
      Utils.qs('#m1SimilarPanel')?.classList.add('hidden');
    }
  };

  window.M1 = M1;
})(window, document);
