(function (window, document) {
  'use strict';

  function latestDemand() {
    return Utils.getStorage('tm_demands', [])[0] || null;
  }

  const M2 = {
    switchToM2() {
      DOM.showModule('m2Container', 'm2');
      const demand = latestDemand();
      DOM.setHtml('m2Content', `
        <div class="m2-layout">
          <div class="m2-section">
            <h3>策略规划</h3>
            <p class="text-muted">这里用于把已接入需求继续拆成投放策略。当前版本先读取最新需求并生成策略摘要。</p>
            <div class="m3-actions"><button class="btn btn-primary" onclick="M2.generateAIStrategy()">生成策略摘要</button><button class="btn btn-outline" onclick="M3.switchToM3()">进入需求方案</button></div>
          </div>
          <div class="m2-section"><div id="m2Result" class="m2-result-content">${demand ? `<h2>${Utils.escapeHtml(demand.brand)} 最新需求</h2><p>${Utils.escapeHtml(demand.objective || demand.brief || '')}</p>` : '<div class="empty-state"><p>暂无需求，请先在 M3 接入需求。</p></div>'}</div></div>
        </div>
      `);
    },

    generateAIStrategy() {
      const demand = latestDemand();
      if (!demand) {
        Utils.toast('请先接入需求', 'warning');
        return;
      }
      const text = `
        <h2>${Utils.escapeHtml(demand.brand)} 策略摘要</h2>
        <h3>目标</h3><p>${Utils.escapeHtml(demand.objective)}</p>
        <h3>打法</h3>
        <ul>
          <li>先用内容测试验证卖点，再扩大达人组合。</li>
          <li>把交付物拆成测评、短视频和授权素材三类资产。</li>
          <li>将确认后的方案同步到 PPT 生成流程。</li>
        </ul>
      `;
      DOM.setHtml('m2Result', text);
      window.KB?.addEntry({
        category: 'strategy',
        title: `${demand.brand} 策略摘要`,
        content: Utils.qs('#m2Result')?.innerText || '',
        tags: [demand.brand, demand.market, 'strategy'].filter(Boolean),
        source: 'M2策略规划'
      });
      Utils.toast('策略摘要已生成并归档', 'success');
    }
  };

  window.M2 = M2;
})(window, document);
