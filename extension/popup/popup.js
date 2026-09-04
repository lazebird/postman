/**
 * popup.js - Popup 逻辑（v0.8.0 UI 重构版）
 *
 * 标签页结构：状态 → 探测 → 设置 → 统计 → 日志
 * - 设置标签页：整合原 Options 页面的配置内容（账户管理/检查设置/接口选择）
 * - 统计标签页：会话授权状态、数据统计、最近检查记录
 * - 日志标签页放最后
 * - 所有标签页内去除冗余标题行，精简界面
 */

// ========== 常量 ==========
const PROVIDER_LABELS = {
  netease_163: '163邮箱',
  qq: 'QQ邮箱',
  ustc: '中科大',
  gmail: 'Gmail',
};

const ENDPOINT_OPTIONS = {
  netease_163: [
    { name: 'js6_rpc_list', label: 'RPC · 收件箱列表' },
    { name: 'js6_rpc_getfolder', label: 'RPC · 文件夹计数' },
    { name: 'js6_rpc_getunread', label: 'RPC · 未读计数' },
    { name: 'js6_sys_getfolder', label: 'RPC · 会话信息' },
  ],
  qq: [
    { name: 'wx_readdata', label: '新网页版 · 读取收件箱' },
    { name: 'wx_readindex', label: '新网页版 · 读取邮箱索引' },
    { name: 'wx_mail_list', label: '新网页版 · 收件箱列表' },
    { name: 'wx_unread', label: '新网页版 · 未读计数' },
    { name: 'cgi_mail_list', label: '旧版 · 收件箱列表' },
    { name: 'cgi_fr_show', label: '旧版 · 轻量未读' },
  ],
  ustc: [
    { name: 'ustc_getallfolders', label: '获取所有文件夹' },
    { name: 'ustc_getattrs', label: '获取用户属性' },
  ],
  gmail: [
    { name: 'gmail_api', label: 'Gmail REST API' },
  ],
};

let currentAccounts = [];
let currentSettings = {};

// ========== Tab 切换 ==========
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    tab.classList.add('active');
    const tabId = tab.dataset.tab;
    document.getElementById(`tab-${tabId}`).classList.add('active');
    // 切换时按需刷新数据
    if (tabId === 'overview' || tabId === 'stats') refreshStatus();
    if (tabId === 'settings') loadSettingsPanel();
    if (tabId === 'logs') refreshLogs();
  });
});

// ========== 打开完整设置页 ==========
document.getElementById('link-options').addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

// ========== 状态标签页 ==========
async function refreshStatus() {
  try {
    const status = await sendMessage({ type: 'getStatus' });
    // Render based on visible tabs below
    if (isTabVisible('stats')) renderStatsTab(status);
    if (isTabVisible('overview')) renderOverviewAccounts(status);
  } catch (err) {
    console.error('获取状态失败:', err);
  }
}

function isTabVisible(tabId) {
  return document.getElementById(`tab-${tabId}`)?.classList.contains('active') || false;
}

// ========== 状态标签页：单账户「检查」按钮 ==========
// 普通账户走被动探测；Gmail 走「读缓存令牌 → 未授权则弹交互授权 → 再探测」链路，
// 让状态页 Gmail 的「检查」在未授权时也能真正把令牌拿下来（用户主动点击，符合 AGENTS 规则 1）。
async function checkAccountCard(provider, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    if (provider === 'gmail') {
      // 1) 先被动探测：仅读缓存令牌，不开标签 / 不弹窗
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;
      const needsManual = acc?.needsAuth === true || acc?.needsManual === true;
      // 2) 未授权（无有效令牌）→ 用户主动点击，弹交互授权拿令牌，再重新探测
      if (unread == null && needsManual) {
        const auth = await sendMessage({ type: 'gmailAuthorize' });
        if (auth?.success) {
          await sendMessage({ type: 'testProvider', provider: 'gmail' });
        }
      }
    } else {
      await sendMessage({ type: 'testProvider', provider });
    }
    await refreshStatus();
  } catch (err) {
    console.error('刷新失败:', err);
  } finally {
    btn.disabled = false; btn.textContent = '🔄';
  }
}

// 渲染 状态 标签页中的账户卡片
function renderOverviewAccounts(status) {
  const accountsList = document.getElementById('accounts-list');
  const noAccHint = document.getElementById('status-no-account');

  if (!status.accounts?.length) {
    accountsList.innerHTML = '';
    noAccHint.style.display = 'block';
    return;
  }
  noAccHint.style.display = 'none';

  const accStatusMap = {};
  (status.accountStatus || []).forEach(as => { accStatusMap[as.email] = as; });

  accountsList.innerHTML = '';
  status.accounts.forEach(acc => {
    const st = accStatusMap[acc.email] || {};
    const card = document.createElement('div');
    card.className = 'account-card';

    const unread = (typeof st.unreadCount === 'number') ? st.unreadCount : null;
    const unreadHtml = unread !== null
      ? `<span class="acc-unread ${unread > 0 ? 'acc-unread-num' : 'acc-unread-zero'}">${unread}</span>`
      : '<span class="acc-unread acc-unread-zero" style="font-size:13px;">-</span>';

    let statusBadge = '';
    if (st.needsInboxPage === true) {
      statusBadge = '<span class="acc-status-badge acc-status-need">需打开收件箱</span>';
    } else if (st.authVerified === true) {
      statusBadge = '<span class="acc-status-badge acc-status-auth">已授权</span>';
    } else if (st.needsAuth === true) {
      statusBadge = '<span class="acc-status-badge acc-status-need">需授权</span>';
    } else if (st.hasSid === true) {
      statusBadge = '<span class="acc-status-badge acc-status-auth">sid缓存</span>';
    } else {
      statusBadge = '<span class="acc-status-badge acc-status-err">未检查</span>';
    }

    // 「打开收件箱」按钮移除：点击邮箱卡片即可直接打开
    card.dataset.provider = acc.provider;
    card.dataset.email = acc.email;
    card.title = '点击打开邮箱收件箱';

    const refreshBtn = `<button class="acc-action-btn" data-provider="${acc.provider}" data-action="refresh" title="检查该账户">🔄</button>`;

    card.innerHTML = `
      <div class="acc-info">
        <div class="acc-email">${escapeHtml(acc.email)} ${statusBadge}</div>
        <div class="acc-meta">${providerName(acc.provider)}${st.timestamp ? ` · ${new Date(st.timestamp).toLocaleTimeString()}` : ''}${st.method ? ` · ${st.method}` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;">
        ${unreadHtml}
        <div class="acc-actions">${refreshBtn}</div>
      </div>
    `;
    accountsList.appendChild(card);
  });

  // 绑定事件：点击邮箱卡片直接打开收件箱
  accountsList.querySelectorAll('.account-card').forEach(card => {
    card.addEventListener('click', async () => {
      const provider = card.dataset.provider;
      try { await sendMessage({ type: 'openInbox', provider }); }
      catch (err) { console.error('打开邮箱失败:', err); }
    });
    card.querySelectorAll('.acc-action-btn[data-action="refresh"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        checkAccountCard(btn.dataset.provider, btn);
      });
    });
  });
}

function providerName(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

function providerMode(mode) {
  const modes = { 'hybrid': '混合', 'content-script': '内容脚本', 'sw-api': 'SW API' };
  return modes[mode] || mode;
}

// ========== 设置标签页 ==========
async function loadSettingsPanel() {
  try {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    currentAccounts = Array.isArray(accounts) ? accounts : [];
    const { settings = {} } = await chrome.storage.local.get('settings');
    currentSettings = { ...settings };

    renderSettingsAccounts();
    populateSettingsForm();
    renderEndpoints();
  } catch (err) {
    console.error('加载设置失败:', err);
  }
}

function renderSettingsAccounts() {
  const container = document.getElementById('settings-accounts-list');
  if (!currentAccounts.length) {
    container.innerHTML = '<div class="hint">暂无账户，请在上方添加</div>';
    return;
  }
  container.innerHTML = '';
  currentAccounts.forEach((acc, idx) => {
    const item = document.createElement('div');
    item.className = 'acc-manage-item';
    const emailSpan = document.createElement('span');
    emailSpan.title = acc.email;
    emailSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    emailSpan.innerHTML = `${escapeHtml(acc.email)} <span style="color:#adb5bd;font-size:10px;">${PROVIDER_LABELS[acc.provider] || acc.provider}</span>`;
    
    const delBtn = document.createElement('button');
    delBtn.className = 'mini secondary';
    delBtn.style.cssText = 'flex-shrink:0;';
    delBtn.textContent = '删除';
    delBtn.onclick = () => _removeAccount(idx);
    
    item.appendChild(emailSpan);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

function populateSettingsForm() {
  if (currentSettings.checkIntervalMinutes) {
    document.getElementById('interval-select').value = String(currentSettings.checkIntervalMinutes);
  }
  if (currentSettings.logLevel) {
    document.getElementById('loglevel-select').value = currentSettings.logLevel;
  }
  if (currentSettings.checkMode) {
    document.getElementById('mode-select').value = currentSettings.checkMode;
  }
}

function renderEndpoints() {
  const container = document.getElementById('endpoint-config');
  if (!container) return;

  const sections = Object.keys(ENDPOINT_OPTIONS).map(provider => {
    const endpoints = ENDPOINT_OPTIONS[provider];
    const savedEnabled = currentSettings.enabledEndpoints?.[provider];
    const enabled = Array.isArray(savedEnabled) && savedEnabled.length > 0
      ? savedEnabled
      : endpoints.map(ep => ep.name); // 默认全部启用

    const checks = endpoints.map(ep => {
      const checked = enabled.includes(ep.name) ? 'checked' : '';
      return `
        <div class="endpoint-checkbox">
          <input type="checkbox" id="ep-${provider}-${ep.name}" data-provider="${provider}" data-endpoint="${ep.name}" ${checked}>
          <label for="ep-${provider}-${ep.name}">${escapeHtml(ep.label)}</label>
        </div>
      `;
    }).join('');

    return `
      <div class="endpoint-group">
        <div class="ep-provider">${PROVIDER_LABELS[provider] || provider}</div>
        ${checks}
      </div>
    `;
  }).join('');

  container.innerHTML = sections;
}

async function _addAccount() {
  const email = document.getElementById('email-input').value.trim();

  if (!email) { showSaveStatus('请输入邮箱地址', 'error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showSaveStatus('邮箱格式不正确', 'error'); return; }

  // 根据邮箱域名自动识别提供商
  const domain = email.split('@')[1]?.toLowerCase() || '';
  let provider = 'gmail'; // 默认
  if (domain.includes('163.com') || domain.includes('vip.163.com')) {
    provider = 'netease_163';
  } else if (domain.includes('qq.com')) {
    provider = 'qq';
  } else if (domain.includes('ustc.edu.cn')) {
    provider = 'ustc';
  } else if (domain.includes('gmail.com')) {
    provider = 'gmail';
  }

  if (currentAccounts.some(a => a.email === email && a.provider === provider)) {
    showSaveStatus('该账户已存在', 'error'); return;
  }

  currentAccounts.push({ email, provider, addedAt: new Date().toISOString() });
  await chrome.storage.local.set({ accounts: currentAccounts });
  renderSettingsAccounts();
  document.getElementById('email-input').value = '';
  notifyAccountsChanged();
  showSaveStatus('账户已添加', 'success');
  refreshStatus();
}

async function _removeAccount(index) {
  currentAccounts.splice(index, 1);
  await chrome.storage.local.set({ accounts: currentAccounts });
  renderSettingsAccounts();
  notifyAccountsChanged();
  showSaveStatus('账户已删除', 'success');
  refreshStatus();
}

async function _saveSettings() {
  const interval = parseInt(document.getElementById('interval-select').value, 10);
  const logLevel = document.getElementById('loglevel-select').value;
  const checkMode = document.getElementById('mode-select').value;

  // 收集端点
  const enabledEndpoints = {};
  document.querySelectorAll('input[type="checkbox"][data-provider]').forEach(cb => {
    const provider = cb.dataset.provider;
    if (!enabledEndpoints[provider]) enabledEndpoints[provider] = [];
    if (cb.checked) enabledEndpoints[provider].push(cb.dataset.endpoint);
  });
  // 确保每个provider至少启用一个
  for (const provider of Object.keys(ENDPOINT_OPTIONS)) {
    if (!enabledEndpoints[provider] || enabledEndpoints[provider].length === 0) {
      enabledEndpoints[provider] = [ENDPOINT_OPTIONS[provider][0].name];
    }
  }

  currentSettings = {
    ...currentSettings,
    checkIntervalMinutes: interval,
    logLevel,
    checkMode,
    enabledEndpoints,
  };

  await chrome.storage.local.set({ settings: currentSettings });
  try { chrome.runtime.sendMessage({ type: 'settingsChanged' }); } catch (e) {}
  showSaveStatus('设置已保存', 'success');
}

async function _resetSettings() {
  if (!confirm('确定要重置所有设置吗？所有账户和配置将被清除。')) return;
  await chrome.storage.local.clear();
  currentAccounts = [];
  currentSettings = {};
  await loadSettingsPanel();
  showSaveStatus('已重置所有设置', 'success');
  refreshStatus();
}

function notifyAccountsChanged() {
  try { chrome.runtime.sendMessage({ type: 'accountsChanged' }); } catch (e) {}
}

function showSaveStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = `save-status ${type}`;
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// 暴露给 onclick 的全局函数
window._addAccount = _addAccount;
window._removeAccount = _removeAccount;

// ========== 统计标签页 ==========
function renderStatsTab(status) {
  if (!status) return;
  renderSessionStatus(status);
  renderStatsGrid(status);
  renderRecentChecks(status);
}

function renderSessionStatus(status) {
  const container = document.getElementById('session-status');
  if (!container) return;

  const sids = status.cachedSids || {};
  const providers = [
    { key: 'netease_163', label: '163邮箱' },
    { key: 'qq', label: 'QQ邮箱' },
    { key: 'ustc', label: '中科大' },
    { key: 'gmail', label: 'Gmail' },
  ];

  const rows = providers.map(p => {
    const hasSid = !!sids[p.key];
    const badge = hasSid
      ? '<span class="sid-chip sid-ok">✅ 已授权</span>'
      : '<span class="sid-chip sid-no">❌ 未授权</span>';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
        <strong style="font-size:12px;">${p.label}</strong>${badge}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    ${rows}
    <div class="hint" style="margin-top:6px;">
      sid 约 7 天有效，过期需重新同步授权。<br>
      在「调试」标签页点「同步」按钮即可授权。
    </div>
  `;
}

function renderStatsGrid(status) {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;

  // 计算总未读
  let totalUnread = 0;
  let hasAnyUnread = false;
  (status.accountStatus || []).forEach(as => {
    if (typeof as.unreadCount === 'number') {
      totalUnread += as.unreadCount;
      if (as.unreadCount > 0) hasAnyUnread = true;
    }
  });

  const items = [
    ['账户数', String(status.accountCount || 0)],
    ['全部未读', hasAnyUnread ? `<span style="color:#dc3545;">${totalUnread} 封</span>` : '0 封'],
    ['检查间隔', `${status.settings?.checkIntervalMinutes || 5} 分钟`],
    ['检查模式', providerMode(status.settings?.checkMode || 'hybrid')],
    ['163 API 模式', `${status.apiPatternCounts?.netease_163 || 0} 条`],
    ['QQ API 模式', `${status.apiPatternCounts?.qq || 0} 条`],
    ['USTC API 模式', `${status.apiPatternCounts?.ustc || 0} 条`],
    ['Gmail API 模式', `${status.apiPatternCounts?.gmail || 0} 条`],
    ['定时闹钟', status.alarmConfigured
      ? `✅ ${status.alarmInfo?.periodInMinutes || '?'}分/次`
      : '❌ 未配置'],
    ['日志级别', status.settings?.logLevel || 'DEBUG'],
  ];

  grid.innerHTML = items.map(([label, value]) => `
    <div class="stat-cell">
      <span class="s-label">${label}</span>
      <span class="s-value">${value}</span>
    </div>
  `).join('');
}

function renderRecentChecks(status) {
  const container = document.getElementById('recent-checks');
  if (!container) return;

  const results = status.recentResults || [];
  if (!results.length) {
    container.innerHTML = '<div class="empty" style="padding:8px;">暂无检查记录</div>';
    return;
  }

  // 过滤出有实际意义的记录（显示最近10条）
  const meaningful = results.filter(r =>
    r.email || (r.unreadCount !== undefined && r.unreadCount !== null) ||
    r.authVerified !== undefined || r.needsAuth !== undefined || Array.isArray(r.results)
  ).slice(0, 10);

  if (!meaningful.length) {
    container.innerHTML = '<div class="empty" style="padding:8px;">暂无检查记录</div>';
    return;
  }

  container.innerHTML = meaningful.map(r => {
    const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '';
    const provider = r.provider ? (PROVIDER_LABELS[r.provider] || r.provider) : '';
    const email = r.email || '';
    const hasUnread = typeof r.unreadCount === 'number';
    const isSummary = Array.isArray(r.results);
    let statusText = '';
    let statusCls = '';

    if (isSummary) {
      // 汇总结果 - 检查是否成功
      const okCount = r.results.filter(rr => rr.authVerified || typeof rr.unreadCount === 'number').length;
      statusText = `已检查 ${okCount}/${r.results.length} 个`;
      statusCls = okCount > 0 ? 'status-ok' : 'status-fail';
    } else if (hasUnread) {
      statusText = `未读 ${r.unreadCount} 封`;
      statusCls = r.unreadCount > 0 ? 'acc-unread-num' : 'acc-unread-zero';
    } else if (r.authVerified === true) {
      statusText = '已授权';
      statusCls = 'status-ok';
    } else if (r.needsAuth === true) {
      statusText = '需授权';
      statusCls = 'status-fail';
    } else if (r.error) {
      statusText = '失败';
      statusCls = 'status-fail';
    } else {
      statusText = '已检查';
      statusCls = 'status-idle';
    }

    return `
      <div class="recent-item">
        <span class="r-time">${time || '--'}</span>
        <span class="r-provider">${email || provider || '全量'}</span>
        <span class="r-status ${statusCls}" style="font-size:10px;">${statusText}</span>
      </div>
    `;
  }).join('');
}

// ========== 探测标签页 ==========
// 同步会话
async function syncSession(provider) {
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  showProbeResult(`同步 ${providerLabel}`, { message: '正在同步...' });

  try {
    // 根据提供商选择正确的消息类型
    let msgType = 'probeContent163';
    if (provider === 'qq') msgType = 'probeContentQQ';
    else if (provider === 'ustc') msgType = 'probeContentUSTC';
    else if (provider === 'gmail') msgType = 'gmailAuthorize';

    const r = await sendMessage({ type: msgType, openTab: true });

    // Gmail 走 OAuth2 授权，返回扁平结果 { success, token }，无 probe 字段。
    if (provider === 'gmail' && r?.success) {
      showProbeResult(`${providerLabel} 授权成功`, { success: true, message: 'Gmail 授权成功，正在读取未读数...' });
      // 授权完成后触发一次后台探测，读取未读数
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;
      showProbeResult(`${providerLabel} 授权成功`, {
        success: true,
        authVerified: acc?.authVerified === true,
        unreadCount: unread,
        message: unread != null
          ? `授权成功，未读 ${unread} 封`
          : (acc?.needsAuth ? '已授权但未能读取未读数，请稍后重试' : 'Gmail 授权成功'),
        detail: acc?.error || null,
      });
      refreshStatus();
      return;
    }

    if (r?.probe?.success) {
      const sid = r.probe.sid;
      const unread = r.probe.unreadCount;
      const needsInbox = r.probe.needsInboxPage === true || r.probe.authVerified === true;
      const pageType = r.probe.pageType || null;

      const result = {
        authVerified: !!sid,
        sidObtained: !!sid,
        sid: sid ? sid.substring(0, 8) + '...' : null,
        unreadCount: unread ?? null,
        pageType,
        detail: r.probe.detail,
      };

      if (sid) {
        if (typeof unread === 'number') {
          showProbeResult(`${providerLabel} 授权成功`, { ...result, message: `授权成功，未读 ${unread} 封` });
        } else if (needsInbox || pageType !== 'inbox') {
          showProbeResult(`${providerLabel} 已授权`, { ...result, message: '已授权，请在邮箱中打开「收件箱」后读取未读数' });
        } else {
          showProbeResult(`${providerLabel} 授权成功`, { ...result });
        }
      } else {
        showProbeResult(`${providerLabel} 同步失败`, { ...r.probe, message: '未检测到登录会话，请先登录邮箱' });
      }
    } else {
      showProbeResult(`${providerLabel} 同步失败`, r?.probe || r);
    }
    refreshStatus();
  } catch (err) {
    showProbeResult(`${providerLabel} 同步失败`, { error: err.message });
  }
}

// 内容脚本探测
async function runPlanC(provider) {
  const pre = document.getElementById('probe-result-text');
  if (pre) pre.textContent = '探测中...';
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  // 根据提供商选择正确的消息类型
  let msgType = 'probeContent163';
  if (provider === 'qq') msgType = 'probeContentQQ';
  else if (provider === 'ustc') msgType = 'probeContentUSTC';
  else if (provider === 'gmail') msgType = 'gmailAuthorize';

  try {
    const r = await sendMessage({ type: msgType, openTab: true });

    // Gmail：先直接后台探测（读缓存令牌）；未授权/令牌失效时引导交互授权
    if (provider === 'gmail') {
      if (pre) pre.textContent = '读取未读数中...';
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const needsManual = acc?.needsManual === true || acc?.needsAuth === true;
      let unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;

      // 无有效令牌 → 弹交互授权（仅用户主动点击时）
      if (needsManual && unread == null) {
        showProbeResult(`获取未读数 · ${providerLabel}`, { success: false, message: 'Gmail 未授权，正在弹出授权窗口，请在弹出的 Google 页面中确认...' });
        const auth = await sendMessage({ type: 'gmailAuthorize' });
        if (auth?.success) {
          if (pre) pre.textContent = '授权成功，读取未读数中...';
          const probe2 = await sendMessage({ type: 'testProvider', provider: 'gmail' });
          const acc2 = probe2?.results?.[0];
          unread = acc2 && typeof acc2.unreadCount === 'number' ? acc2.unreadCount : null;
          if (pre) {
            showProbeResult(`获取未读数 · ${providerLabel}`, {
              success: unread != null,
              unreadCount: unread,
              authVerified: acc2?.authVerified === true,
              detail: acc2?.error || null,
            });
          }
        } else {
          if (pre) showProbeResult(`获取未读数 · ${providerLabel}`, { success: false, message: 'Gmail 授权未完成或已取消', error: auth?.error || null });
        }
        refreshStatus();
        return;
      }

      if (pre) {
        showProbeResult(`获取未读数 · ${providerLabel}`, {
          success: unread != null,
          unreadCount: unread,
          authVerified: acc?.authVerified === true,
          detail: acc?.error || null,
        });
      }
      refreshStatus();
      return;
    }

    const success = r?.probe?.success;
    const result = success ? r?.probe : r;
    if (pre) {
      showProbeResult(`获取未读数 · ${providerLabel}`, {
        success,
        unreadCount: r?.probe?.unreadCount ?? null,
        authVerified: r?.probe?.authVerified === true,
        detail: r?.probe?.detail || r?.error || null,
      });
    }
    refreshStatus();
  } catch (err) {
    if (pre) showProbeResult(`获取未读数失败`, { error: err.message });
  }
}

// Cookie 诊断
async function runCookieDiag() {
  showProbeResult('Cookie 诊断', { message: '诊断中...' });
  try {
    const r = await sendMessage({ type: 'diagnoseCookies' });
    showProbeResult('🍪 Cookie 诊断', r);
  } catch (err) {
    showProbeResult('Cookie 诊断失败', { error: err.message });
  }
}

// SW 探测
async function runSWProbe(provider) {
  const btnMap = {
    'netease_163': 'btn-probe-163',
    'qq': 'btn-probe-qq',
    'ustc': 'btn-probe-ustc',
    'gmail': 'btn-probe-gmail',
  };
  const btn = document.getElementById(btnMap[provider]);
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '探测中...'; }
  try {
    const result = await sendMessage({ type: 'testProvider', provider });
    showProbeResult(`${PROVIDER_LABELS[provider]} 探测`, result);
    refreshStatus();
  } catch (err) {
    showProbeResult(`${PROVIDER_LABELS[provider]} 探测失败`, { success: false, error: err.message });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// 检查认证
async function runCheckBridge() {
  showProbeResult('检查认证', { message: '检查中...' });
  try {
    const [r163, rQQ] = await Promise.all([
      sendMessage({ type: 'checkBridge', provider: 'netease_163' }),
      sendMessage({ type: 'checkBridge', provider: 'qq' }),
    ]);
    showProbeResult('认证状态', {
      '163': { authState: r163?.authState, loggedIn: r163?.loggedIn, needsAuth: r163?.needsAuth },
      'QQ': { authState: rQQ?.authState, loggedIn: rQQ?.loggedIn, needsAuth: rQQ?.needsAuth },
    });
  } catch (err) {
    showProbeResult('认证检查失败', { error: err.message });
  }
}

// 刷新会话
async function runRefreshSession() {
  showProbeResult('刷新会话', { message: '刷新中...' });
  try {
    const results = {};
    for (const provider of ['netease_163', 'qq']) {
      const r = await sendMessage({ type: 'refreshSession', provider });
      results[provider === 'netease_163' ? '163' : 'QQ'] = {
        loggedIn: r.loggedIn,
        needsAuth: r.needsAuth,
        hasSid: r.hasSid,
        sid: r.sid || null,
        contentUnread: r.contentProbe?.probe?.unreadCount ?? null,
      };
    }
    showProbeResult('会话刷新结果', results);
    refreshStatus();
  } catch (err) {
    showProbeResult('会话刷新失败', { error: err.message });
  }
}

// 全局 Loading 控制
function showLoading() {
  const el = document.getElementById('global-loading');
  if (el) el.style.display = 'flex';
}

function hideLoading() {
  const el = document.getElementById('global-loading');
  if (el) el.style.display = 'none';
}

// 全量检查
async function runFullCheck() {
  // 同时处理状态页和调试页的全量检查按钮
  const btn = document.getElementById('btn-full-check') || document.getElementById('btn-full-check-status');
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 检查中...'; }
  showLoading();
  try {
    const result = await sendMessage({ type: 'runCheck' });
    showProbeResult('全量检查结果', result);
    refreshStatus();
  } catch (err) {
    showProbeResult('全量检查失败', { success: false, error: err.message });
  } finally {
    hideLoading();
    if (btn) { btn.disabled = false; btn.textContent = origText || '🚀 全量检查'; }
  }
}


// 「全可能性」后台无标签测试
async function runPossibilityTest() {
  const btn = document.getElementById('btn-possibility');
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 测试中（请耐心等待，涉及多接口）...'; }
  showProbeResult('🧪 全可能性后台测试', { message: '正在逐策略探测 163/QQ 各接口，结果将输出为日志，请稍候...' });
  try {
    const result = await sendMessage({ type: 'possibilityTest', provider: 'all' });
    showProbeResult('🧪 全可能性后台测试结果', result);
  } catch (err) {
    showProbeResult('全可能性测试失败', { success: false, error: err.message });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || '🧪 全可能性后台测试'; }
  }
}

// ========== 结果显示 ==========
function showProbeResult(title, data) {
  const container = document.getElementById('probe-result');
  const textEl = document.getElementById('probe-result-text');
  const titleEl = document.getElementById('probe-result-title');
  const copyBtn = document.getElementById('btn-copy-result');

  container.style.display = 'block';
  if (typeof data === 'string') {
    textEl.textContent = data;
  } else {
    textEl.textContent = JSON.stringify(data, null, 2);
  }
  if (titleEl) titleEl.textContent = title ? `【${title}】` : '';
  if (copyBtn) { copyBtn.textContent = '📋'; copyBtn.classList.remove('copied'); }
}

// 复制
const btnCopyResult = document.getElementById('btn-copy-result');
if (btnCopyResult) {
  btnCopyResult.addEventListener('click', async () => {
    const textEl = document.getElementById('probe-result-text');
    const titleEl = document.getElementById('probe-result-title');
    if (!textEl.textContent) return;
    const copyText = titleEl.textContent
      ? `${titleEl.textContent}\n${textEl.textContent}`
      : textEl.textContent;
    try {
      await navigator.clipboard.writeText(copyText);
      btnCopyResult.textContent = '✅';
      btnCopyResult.classList.add('copied');
      setTimeout(() => { btnCopyResult.textContent = '📋'; btnCopyResult.classList.remove('copied'); }, 2000);
    } catch (err) {
      // Fallback
      try {
        const originalText = textEl.textContent;
        const titleText = titleEl?.textContent || '';
        const fullText = titleText ? `${titleText}\n${originalText}` : originalText;
        textEl.textContent = fullText;
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        textEl.textContent = originalText;
        sel.removeAllRanges();
        btnCopyResult.textContent = '✅';
        btnCopyResult.classList.add('copied');
        setTimeout(() => { btnCopyResult.textContent = '📋'; btnCopyResult.classList.remove('copied'); }, 2000);
      } catch (e2) {
        btnCopyResult.textContent = '❌';
      }
    }
  });
}

// ========== 日志标签页 ==========
// 日志读取（切换至日志标签页时自动刷新）
async function refreshLogs() {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    const container = document.getElementById('logs-container');
    if (!container) return;
    if (!debugLogs.length) {
      container.innerHTML = '<div class="empty">暂无日志</div>';
      return;
    }
    container.innerHTML = debugLogs.slice(0, 100).map(log => {
      const cls = (log.level || 'info').toLowerCase();
      const detail = log.detail ? `<br><small>${escapeHtml(log.detail)}</small>` : '';
      return `<div class="${cls}">[${new Date(log.ts).toLocaleTimeString()}] [${log.level}] [${escapeHtml(log.module)}] ${escapeHtml(log.message)}${detail}</div>`;
    }).join('');
  } catch (err) {
    const container = document.getElementById('logs-container');
    if (container) {
      container.innerHTML = `<div class="error">读取日志失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function fetchLogsFromStorage(limit = 100) {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    return Array.isArray(debugLogs) ? debugLogs.slice(0, limit) : [];
  } catch (e) {
    return [];
  }
}

/**
 * 获取日志（供外部 API 调用）
 * 可通过 sendMessage({ type: 'getLogs' }) 调用
 */
async function getLogsAPI(limit = 100) {
  return await fetchLogsFromStorage(limit);
}

function logsToPlainText(logs) {
  return logs.map(log => {
    const t = new Date(log.ts).toLocaleTimeString();
    const detail = log.detail ? `\n${log.detail}` : '';
    return `[${t}] [${log.level}] [${log.module}] ${log.message}${detail}`;
  }).join('\n');
}

async function copyLogs() {
  const copyBtn = document.getElementById('btn-copy-logs');
  if (!copyBtn) return;
  const logs = await fetchLogsFromStorage();
  const text = logsToPlainText(logs);
  if (!text) {
    copyBtn.textContent = '❌ 无日志';
    setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 2000);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = '✅ 已复制';
    copyBtn.classList.add('copied');
  } catch (err) {
    // clipboard API 不可用时回退到 execCommand
    const container = document.getElementById('logs-container');
    const original = container.textContent;
    container.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(container);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    container.textContent = original;
    sel.removeAllRanges();
    copyBtn.textContent = ok ? '✅ 已复制' : '❌ 复制失败';
    copyBtn.classList.toggle('copied', ok);
  }
  setTimeout(() => {
    copyBtn.textContent = '📋 复制';
    copyBtn.classList.remove('copied');
  }, 2000);
}

async function clearLogs() {
  const clearBtn = document.getElementById('btn-clear-logs');
  if (!clearBtn) return;
  try {
    await chrome.storage.session.remove('debugLogs');
    document.getElementById('logs-container').innerHTML = '<div class="empty">暂无日志</div>';
    clearBtn.textContent = '✅ 已清除';
    setTimeout(() => { clearBtn.textContent = '🗑 清除'; }, 2000);
  } catch (err) {
    clearBtn.textContent = '❌ 清除失败';
    setTimeout(() => { clearBtn.textContent = '🗑 清除'; }, 2000);
  }
}

// 复制 / 清除日志
document.getElementById('btn-copy-logs')?.addEventListener('click', copyLogs);
document.getElementById('btn-clear-logs')?.addEventListener('click', clearLogs);
// ========== 公共工具 ==========
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// ========== 折叠面板控制 ==========
function setupCollapse(btnId, contentId) {
  const btn = document.getElementById(btnId);
  const content = document.getElementById(contentId);
  if (!btn || !content) return;

  btn.addEventListener('click', () => {
    content.classList.toggle('open');
    const isOpen = content.classList.contains('open');
    btn.textContent = (isOpen ? '▾ ' : '▸ ') + btn.textContent.substring(2);
    // 如果首次展开端点配置且为空，加载
    if (isOpen && contentId === 'endpoint-config' && !content.innerHTML) {
      renderEndpoints();
    }
  });
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
  // 折叠面板
  setupCollapse('btn-toggle-advanced', 'advanced-probe');
  setupCollapse('btn-toggle-endpoints', 'endpoint-config');

  // 探测标签页 - 内容脚本探测
  document.getElementById('btn-content-163')?.addEventListener('click', () => runPlanC('netease_163'));
  document.getElementById('btn-content-qq')?.addEventListener('click', () => runPlanC('qq'));
  document.getElementById('btn-content-ustc')?.addEventListener('click', () => runPlanC('ustc'));
  document.getElementById('btn-content-gmail')?.addEventListener('click', () => runPlanC('gmail'));

  // 同步会话
  document.getElementById('btn-sync-163')?.addEventListener('click', () => syncSession('netease_163'));
  document.getElementById('btn-sync-qq')?.addEventListener('click', () => syncSession('qq'));
  document.getElementById('btn-sync-ustc')?.addEventListener('click', () => syncSession('ustc'));
  document.getElementById('btn-sync-gmail')?.addEventListener('click', () => syncSession('gmail'));

  // 全量检查
  document.getElementById('btn-full-check')?.addEventListener('click', runFullCheck);
  document.getElementById('btn-full-check-status')?.addEventListener('click', runFullCheck);

  // Cookie 诊断
  document.getElementById('btn-diagnose-cookies')?.addEventListener('click', runCookieDiag);

  // 高级探测
  document.getElementById('btn-probe-163')?.addEventListener('click', () => runSWProbe('netease_163'));
  document.getElementById('btn-probe-qq')?.addEventListener('click', () => runSWProbe('qq'));
  document.getElementById('btn-probe-ustc')?.addEventListener('click', () => runSWProbe('ustc'));
  document.getElementById('btn-probe-gmail')?.addEventListener('click', () => runSWProbe('gmail'));
  document.getElementById('btn-check-bridge')?.addEventListener('click', runCheckBridge);
  document.getElementById('btn-refresh-session')?.addEventListener('click', runRefreshSession);
  document.getElementById('btn-possibility')?.addEventListener('click', runPossibilityTest);

  // 设置标签页
  document.getElementById('btn-add-account')?.addEventListener('click', _addAccount);
  document.getElementById('btn-save')?.addEventListener('click', _saveSettings);
  document.getElementById('btn-reset')?.addEventListener('click', _resetSettings);
  document.getElementById('email-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _addAccount();
  });

  // 初始化刷新状态
  refreshStatus();

  // 暴露日志获取 API（供 Playwright 等外部工具调用）
  window.getMailNotifierLogs = async (limit = 100) => {
    return await getLogsAPI(limit);
  };
});
