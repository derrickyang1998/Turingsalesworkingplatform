(function (window, document) {
  'use strict';

  const users = [
    { id: 'u1', name: 'Turing BD', role: '商务', active: true },
    { id: 'u2', name: 'Strategy Lead', role: '策略', active: true }
  ];

  const Admin = {
    switchToAdmin() {
      DOM.showModule('adminContainer', 'admin');
      const demands = Utils.getStorage('tm_demands', []);
      DOM.setHtml('adminContent', `
        <div class="admin-stats">
          <div class="admin-stat-card"><div class="label">用户</div><div class="value">${users.length}</div></div>
          <div class="admin-stat-card success"><div class="label">需求</div><div class="value">${demands.length}</div></div>
          <div class="admin-stat-card warning"><div class="label">已确认方案</div><div class="value">${demands.filter((item) => item.status === 'confirmed').length}</div></div>
        </div>
        <div class="admin-section">
          <h3>用户管理</h3>
          <table class="admin-table"><thead><tr><th>状态</th><th>姓名</th><th>角色</th><th>操作</th></tr></thead>
          <tbody>${users.map((user) => `<tr><td><span class="admin-user-status ${user.active ? 'active' : 'inactive'}"></span>${user.active ? '启用' : '停用'}</td><td>${user.name}</td><td>${user.role}</td><td><button class="btn btn-outline btn-sm" onclick="Admin.showUserModal('${user.id}')">查看</button></td></tr>`).join('')}</tbody></table>
        </div>
      `);
    },

    showUserModal(id) {
      const user = users.find((item) => item.id === id) || users[0];
      DOM.setHtml('adminUserModalTitle', '用户信息');
      DOM.setHtml('adminUserModalBody', `<p>${Utils.escapeHtml(user.name)} · ${Utils.escapeHtml(user.role)}</p><p class="text-muted">静态版本暂不修改权限。</p>`);
      Utils.qs('#adminUserModal')?.classList.add('open');
    },

    closeUserModal() {
      Utils.qs('#adminUserModal')?.classList.remove('open');
    },

    saveUser() {
      Admin.closeUserModal();
      Utils.toast('静态版本暂不保存用户变更', 'info');
    },

    adminAddUser() {
      Utils.toast('用户新增将在后续接后端后开放', 'info');
    },

    toggleUserActive() {
      Utils.toast('用户状态切换将在后续接后端后开放', 'info');
    },

    loadAdminUsers() {
      return users;
    }
  };

  window.Admin = Admin;
})(window, document);
