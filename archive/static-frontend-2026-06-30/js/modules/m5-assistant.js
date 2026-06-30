(function (window, document) {
  'use strict';

  const M5 = {
    switchToM5() {
      DOM.showModule('m5Container', 'm5');
      DOM.setHtml('m5Content', `
        <div class="m5-chat-area" id="m5Chat">
          <div class="m5-message m5-system">AI助手静态版本：可读取当前需求和知识库摘要，后续可接入真实模型。</div>
          <div class="m5-message m5-assistant">你可以让我总结最新需求、检查方案是否可导出，或提示下一步需要补充的信息。</div>
        </div>
        <div class="m5-input-area">
          <textarea id="m5Input" placeholder="输入问题，例如：总结最新需求"></textarea>
          <button class="btn btn-primary" onclick="M5.send()">发送</button>
        </div>
      `);
    },

    send() {
      const input = Utils.qs('#m5Input');
      const chat = Utils.qs('#m5Chat');
      if (!input || !chat || !input.value.trim()) return;
      const question = input.value.trim();
      const demands = Utils.getStorage('tm_demands', []);
      const latest = demands[0];
      chat.insertAdjacentHTML('beforeend', `<div class="m5-message m5-user">${Utils.escapeHtml(question)}</div>`);
      const answer = latest
        ? `最新需求是 ${latest.brand}，目标为：${latest.objective || latest.brief || '暂无目标'}。当前状态：${latest.status || 'intake'}。`
        : '当前还没有需求，请先到“需求方案”模块接入客户需求。';
      chat.insertAdjacentHTML('beforeend', `<div class="m5-message m5-assistant">${Utils.escapeHtml(answer)}</div>`);
      input.value = '';
      chat.scrollTop = chat.scrollHeight;
    }
  };

  window.M5 = M5;
})(window, document);
