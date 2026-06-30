(function (window, document) {
  'use strict';

  const rows = [
    { handle: '@beautywithmia', platform: 'TikTok', country: 'US', followers: '420K', tag: '美妆测评', cost: '¥18,000' },
    { handle: '@techdesk', platform: 'YouTube', country: 'DE', followers: '180K', tag: '3C开箱', cost: '¥25,000' },
    { handle: '@homefinds', platform: 'Instagram', country: 'SG', followers: '96K', tag: '家居生活', cost: '¥8,000' }
  ];

  const M4 = {
    switchToM4() {
      DOM.showModule('m4Container', 'm4');
      DOM.setHtml('m4Content', `
        <div class="m4-stats">
          <div class="m4-stat"><strong>${rows.length}</strong> 个候选达人</div>
          <div class="m4-stat"><strong>3</strong> 个平台</div>
          <div class="m4-stat"><strong>静态演示</strong> 数据源</div>
        </div>
        <div class="m4-table-wrap">
          <table><thead><tr><th>KOL</th><th>平台</th><th>国家</th><th>粉丝</th><th>标签</th><th>预估报价</th></tr></thead>
          <tbody>${rows.map((item) => `<tr><td>${item.handle}</td><td>${item.platform}</td><td>${item.country}</td><td>${item.followers}</td><td>${item.tag}</td><td>${item.cost}</td></tr>`).join('')}</tbody></table>
        </div>
      `);
    }
  };

  window.M4 = M4;
})(window, document);
