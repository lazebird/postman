/**
 * popup.js - Popup 逻辑（单一 UI，Options 页已移除）
 *
 * 标签页结构（与 popup/index.html 的 DOM 顺序一致）：
 *   状态 → 设置 → 统计 → 日志 → 调试
 * - 设置标签页：账户管理 / 检查设置 / 探测接口选择（原 Options 内容已全部收敛于此）
 * - 统计标签页：会话授权状态、数据统计、最近检查记录
 * - 调试标签页：面向开发的诊断能力（折叠，普通用户默认不展开）
 */

// ========== 常量（收敛于 shared/ui-meta.js 单一事实源）==========
import { PROVIDER_LABELS, ENDPOINT_OPTIONS, endpointLabel } from '../shared/ui-meta.js';
import {
  t,
  applyLanguage,
  applyDomI18n,
  getStoredLanguage,
  setStoredLanguage,
  LANGUAGES,
} from '../shared/i18n.js';

let currentAccounts = [];
let currentSettings = {};

// ========== Tab 切换 ==========
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
    tab.classList.add('active');
    const tabId = tab.dataset.tab;
    document.getElementById(`tab-${tabId}`).classList.add('active');
    // 切换时按需刷新数据
    if (tabId === 'overview' || tabId === 'stats') refreshStatus();
    if (tabId === 'settings') loadSettingsPanel();
    if (tabId === 'logs') refreshLogs();
  });
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
// 统一走被动探测：SW 侧按 provider 执行（Gmail 为 Atom feed + 浏览器 Cookie，
// 零 token、不弹授权、不开标签）。未读到未读数时展示原因并提示确认浏览器已登录。
async function checkAccountCard(provider, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const probe = await sendMessage({ type: 'testProvider', provider });
    const acc = probe?.results?.[0];
    const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;

    if (unread == null && provider === 'gmail') {
      // Gmail：Atom feed 失败（401/403/网络）→ 提示确认浏览器已登录 Gmail
      showProbeResult(t('Gmail 检查失败', 'Gmail check failed'), {
        success: false,
        message: t(
          '未能读取 Gmail 未读数，请确认浏览器已登录 Gmail（mail.google.com）',
          'Could not read Gmail unread. Confirm the browser is signed in to Gmail.'
        ),
        error: acc?.error || t('请检查下方原因后处理', 'Check the reason below'),
      });
    }
    await refreshStatus();
  } catch (err) {
    console.error('刷新失败:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄';
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
  (status.accountStatus || []).forEach((as) => {
    accStatusMap[as.email] = as;
  });

  accountsList.innerHTML = '';
  status.accounts.forEach((acc) => {
    const st = accStatusMap[acc.email] || {};
    const card = document.createElement('div');
    card.className = 'account-card';

    const unread = typeof st.unreadCount === 'number' ? st.unreadCount : null;
    const unreadHtml =
      unread !== null
        ? `<span class="acc-unread ${unread > 0 ? 'acc-unread-num' : 'acc-unread-zero'}">${unread}</span>`
        : '<span class="acc-unread acc-unread-zero acc-unread-placeholder">-</span>';

    let statusBadge = '';
    if (st.needsInboxPage === true) {
      statusBadge = `<span class="acc-status-badge acc-status-need">${t('需打开收件箱', 'Open inbox needed')}</span>`;
    } else if (st.authVerified === true) {
      statusBadge = `<span class="acc-status-badge acc-status-auth">${t('已授权', 'authorized')}</span>`;
    } else if (st.needsAuth === true) {
      statusBadge = `<span class="acc-status-badge acc-status-need">${t('需授权', 'needs auth')}</span>`;
    } else if (st.hasSid === true) {
      statusBadge = `<span class="acc-status-badge acc-status-auth">sid cache</span>`;
    } else {
      statusBadge = `<span class="acc-status-badge acc-status-err">${t('未检查', 'unchecked')}</span>`;
    }

    // 明确的操作按钮：打开邮箱 / 检查该账户，避免整卡误触
    card.dataset.provider = acc.provider;
    card.dataset.email = acc.email;

    const actionsHtml = `
      <div class="acc-actions">
        <button class="acc-action-btn jump" data-action="open" data-provider="${acc.provider}"
          title="${t('打开邮箱收件箱', 'Open mailbox inbox')}" aria-label="${t('打开', 'Open')} ${escapeHtml(acc.email)} ${t('收件箱', 'inbox')}">↗</button>
        <button class="acc-action-btn" data-action="refresh" data-provider="${acc.provider}"
          title="${t('检查该账户', 'Check this account')}" aria-label="${t('检查', 'Check')} ${escapeHtml(acc.email)}">🔄</button>
      </div>
    `;

    card.innerHTML = `
      <div class="acc-info">
        <div class="acc-email">${escapeHtml(acc.email)} ${statusBadge}</div>
        <div class="acc-meta">${providerName(acc.provider)}${st.timestamp ? ` · ${new Date(st.timestamp).toLocaleTimeString()}` : ''}${st.method ? ` · ${st.method}` : ''}</div>
      </div>
      <div class="acc-right">
        ${unreadHtml}
        ${actionsHtml}
      </div>
    `;
    accountsList.appendChild(card);
  });

  // 通过显式按钮触发打开/检查，卡片整体不再作为点击热区
  accountsList.querySelectorAll('.account-card').forEach((card) => {
    card.querySelectorAll('.acc-action-btn[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.provider;
        try {
          await sendMessage({ type: 'openInbox', provider });
        } catch (err) {
          console.error('打开邮箱失败:', err);
        }
      });
    });
    card.querySelectorAll('.acc-action-btn[data-action="refresh"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        checkAccountCard(btn.dataset.provider, btn);
      });
    });
  });
}

function providerName(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

function providerMode(mode) {
  const modes = {
    hybrid: t('混合', 'Hybrid'),
    'content-script': t('内容脚本', 'Content script'),
    'sw-api': 'SW API',
  };
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
    container.innerHTML = `<div class="hint">${t('暂无账户，请在上方添加', 'No accounts yet, add one above')}</div>`;
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
    delBtn.textContent = t('删除', 'Delete');
    delBtn.onclick = () => _removeAccount(idx);

    item.appendChild(emailSpan);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

async function populateSettingsForm() {
  if (currentSettings.checkIntervalMinutes) {
    document.getElementById('interval-select').value = String(currentSettings.checkIntervalMinutes);
  }
  if (currentSettings.logLevel) {
    document.getElementById('loglevel-select').value = currentSettings.logLevel;
  }
  if (currentSettings.checkMode) {
    document.getElementById('mode-select').value = currentSettings.checkMode;
  }
  await syncLanguageSelect();
}

function renderEndpoints() {
  const container = document.getElementById('endpoint-config');
  if (!container) return;

  const sections = Object.keys(ENDPOINT_OPTIONS)
    .map((provider) => {
      const endpoints = ENDPOINT_OPTIONS[provider];
      const savedEnabled = currentSettings.enabledEndpoints?.[provider];
      const enabled =
        Array.isArray(savedEnabled) && savedEnabled.length > 0
          ? savedEnabled
          : endpoints.map((ep) => ep.name); // 默认全部启用

      const checks = endpoints
        .map((ep) => {
          const checked = enabled.includes(ep.name) ? 'checked' : '';
          return `
        <div class="endpoint-checkbox">
          <input type="checkbox" id="ep-${provider}-${ep.name}" data-provider="${provider}" data-endpoint="${ep.name}" ${checked}>
          <label for="ep-${provider}-${ep.name}">${escapeHtml(endpointLabel(ep))}</label>
        </div>
      `;
        })
        .join('');

      return `
      <div class="endpoint-group">
        <div class="ep-provider">${PROVIDER_LABELS[provider] || provider}</div>
        ${checks}
      </div>
    `;
    })
    .join('');

  container.innerHTML = sections;
}

async function _addAccount() {
  const email = document.getElementById('email-input').value.trim();

  if (!email) {
    showSaveStatus(t('请输入邮箱地址', 'Please enter an email address'), 'error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showSaveStatus(t('邮箱格式不正确', 'Invalid email format'), 'error');
    return;
  }

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

  if (currentAccounts.some((a) => a.email === email && a.provider === provider)) {
    showSaveStatus(t('该账户已存在', 'This account already exists'), 'error');
    return;
  }

  currentAccounts.push({ email, provider, addedAt: new Date().toISOString() });
  await chrome.storage.local.set({ accounts: currentAccounts });
  renderSettingsAccounts();
  document.getElementById('email-input').value = '';
  notifyAccountsChanged();
  showSaveStatus(t('账户已添加', 'Account added'), 'success');
  refreshStatus();
}

async function _removeAccount(index) {
  currentAccounts.splice(index, 1);
  await chrome.storage.local.set({ accounts: currentAccounts });
  renderSettingsAccounts();
  notifyAccountsChanged();
  showSaveStatus(t('账户已删除', 'Account removed'), 'success');
  refreshStatus();
}

async function _saveSettings() {
  const interval = parseInt(document.getElementById('interval-select').value, 10);
  const logLevel = document.getElementById('loglevel-select').value;
  const checkMode = document.getElementById('mode-select').value;

  // 收集端点
  const enabledEndpoints = {};
  document.querySelectorAll('input[type="checkbox"][data-provider]').forEach((cb) => {
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
  try {
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
  } catch {}
  showSaveStatus(t('设置已保存', 'Settings saved'), 'success');
}

async function _resetSettings() {
  if (
    !confirm(
      t(
        '确定要重置所有设置吗？所有账户和配置将被清除。',
        'Reset all settings? All accounts and configuration will be cleared.'
      )
    )
  )
    return;
  await chrome.storage.local.clear();
  currentAccounts = [];
  currentSettings = {};
  await loadSettingsPanel();
  showSaveStatus(t('已重置所有设置', 'All settings reset'), 'success');
  refreshStatus();
}

function notifyAccountsChanged() {
  try {
    chrome.runtime.sendMessage({ type: 'accountsChanged' });
  } catch {}
}

// 保存提示的隐藏定时器句柄：连续操作时先清除旧的，避免提示被提前覆盖隐藏
let saveStatusHideTimer = null;

function showSaveStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = `save-status ${type}`;
  if (saveStatusHideTimer) clearTimeout(saveStatusHideTimer);
  saveStatusHideTimer = setTimeout(() => {
    el.style.display = 'none';
    saveStatusHideTimer = null;
  }, 3000);
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
    { key: 'netease_163', label: PROVIDER_LABELS['netease_163'] },
    { key: 'qq', label: PROVIDER_LABELS['qq'] },
    { key: 'ustc', label: PROVIDER_LABELS['ustc'] },
    { key: 'gmail', label: PROVIDER_LABELS['gmail'] },
  ];

  const rows = providers
    .map((p) => {
      const hasSid = !!sids[p.key];
      const badge = hasSid
        ? `<span class="sid-chip sid-ok">✅ ${t('已授权', 'authorized')}</span>`
        : `<span class="sid-chip sid-no">❌ ${t('未授权', 'not authorized')}</span>`;
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
        <strong style="font-size:12px;">${p.label}</strong>${badge}
      </div>
    `;
    })
    .join('');

  container.innerHTML = `
    ${rows}
    <div class="hint" style="margin-top:6px;">
      ${t('sid 约 7 天有效，过期需重新同步授权。', 'sid is valid ~7 days; resync when expired.')}<br>
      ${t('在「调试」标签页点「同步」按钮即可授权。', 'Tap Sync in the Debug tab to authorize.')}
    </div>
  `;
}

function renderStatsGrid(status) {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;

  // 计算总未读
  let totalUnread = 0;
  let hasAnyUnread = false;
  (status.accountStatus || []).forEach((as) => {
    if (typeof as.unreadCount === 'number') {
      totalUnread += as.unreadCount;
      if (as.unreadCount > 0) hasAnyUnread = true;
    }
  });

  const items = [
    [t('账户数', 'Accounts'), String(status.accountCount || 0)],
    [
      t('全部未读', 'Total unread'),
      hasAnyUnread
        ? `<span style="color:#dc3545;">${totalUnread} ${t('封', 'msgs')}</span>`
        : `0 ${t('封', 'msgs')}`,
    ],
    [
      t('检查间隔', 'Check interval'),
      `${status.settings?.checkIntervalMinutes || 5} ${t('分钟', 'min')}`,
    ],
    [t('检查模式', 'Check mode'), providerMode(status.settings?.checkMode || 'hybrid')],
    [t('163 API 模式', '163 API patterns'), `${status.apiPatternCounts?.netease_163 || 0}`],
    [t('QQ API 模式', 'QQ API patterns'), `${status.apiPatternCounts?.qq || 0}`],
    [t('USTC API 模式', 'USTC API patterns'), `${status.apiPatternCounts?.ustc || 0}`],
    [
      t('定时闹钟', 'Alarm'),
      status.alarmConfigured
        ? `✅ ${status.alarmInfo?.periodInMinutes || '?'}${t('分/次', 'min/cycle')}`
        : `❌ ${t('未配置', 'not configured')}`,
    ],
    [t('日志级别', 'Log level'), status.settings?.logLevel || 'WARN'],
  ];

  grid.innerHTML = items
    .map(
      ([label, value]) => `
    <div class="stat-cell">
      <span class="s-label">${label}</span>
      <span class="s-value">${value}</span>
    </div>
  `
    )
    .join('');
}

function renderRecentChecks(status) {
  const container = document.getElementById('recent-checks');
  if (!container) return;

  const results = status.recentResults || [];
  if (!results.length) {
    container.innerHTML = `<div class="empty" style="padding:8px;">${t('暂无检查记录', 'No check records')}</div>`;
    return;
  }

  // 过滤出有实际意义的记录（显示最近10条）
  const meaningful = results
    .filter(
      (r) =>
        r.email ||
        (r.unreadCount !== undefined && r.unreadCount !== null) ||
        r.authVerified !== undefined ||
        r.needsAuth !== undefined ||
        Array.isArray(r.results)
    )
    .slice(0, 10);

  if (!meaningful.length) {
    container.innerHTML = `<div class="empty" style="padding:8px;">${t('暂无检查记录', 'No check records')}</div>`;
    return;
  }

  container.innerHTML = meaningful
    .map((r) => {
      const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '';
      const provider = r.provider ? PROVIDER_LABELS[r.provider] || r.provider : '';
      const email = r.email || '';
      const hasUnread = typeof r.unreadCount === 'number';
      const isSummary = Array.isArray(r.results);
      let statusText = '';
      let statusCls = '';

      if (isSummary) {
        // 汇总结果 - 检查是否成功
        const okCount = r.results.filter(
          (rr) => rr.authVerified || typeof rr.unreadCount === 'number'
        ).length;
        statusText = `${t('已检查', 'Checked')} ${okCount}/${r.results.length} ${t('个', 'accounts')}`;
        statusCls = okCount > 0 ? 'status-ok' : 'status-fail';
      } else if (hasUnread) {
        statusText = `${t('未读', 'Unread')} ${r.unreadCount} ${t('封', 'msgs')}`;
        statusCls = r.unreadCount > 0 ? 'acc-unread-num' : 'acc-unread-zero';
      } else if (r.authVerified === true) {
        statusText = t('已授权', 'authorized');
        statusCls = 'status-ok';
      } else if (r.needsAuth === true) {
        statusText = t('需授权', 'needs auth');
        statusCls = 'status-fail';
      } else if (r.error) {
        statusText = t('失败', 'failed');
        statusCls = 'status-fail';
      } else {
        statusText = t('已检查', 'checked');
        statusCls = 'status-idle';
      }

      return `
      <div class="recent-item">
        <span class="r-time">${time || '--'}</span>
        <span class="r-provider">${email || provider || t('全量', 'all')}</span>
        <span class="r-status ${statusCls}" style="font-size:10px;">${statusText}</span>
      </div>
    `;
    })
    .join('');
}

// ========== 探测标签页 ==========
// 同步会话：163/QQ/USTC 走内容脚本页面探测（开标签）；
// Gmail 无内容脚本（Atom feed 走 SW + Cookie），「同步」= 直接 SW 探测读未读数，
// 未读到则提示确认浏览器已登录 mail.google.com。
async function syncSession(provider) {
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  // Gmail：SW 侧 Atom feed 探测（零 token、不弹授权、不开标签）
  if (provider === 'gmail') {
    showProbeResult(`${t('同步', 'Sync')} ${providerLabel}`, {
      message: t('正在读取未读数...', 'Reading unread...'),
    });
    try {
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;
      if (unread != null) {
        showProbeResult(`${providerLabel} ${t('已授权', 'authorized')}`, {
          success: true,
          authVerified: acc?.authVerified === true,
          unreadCount: unread,
          message: `${t('同步成功，未读', 'Synced, unread')} ${unread} ${t('封', 'msgs')}`,
        });
      } else {
        showProbeResult(`${providerLabel} ${t('同步失败', 'sync failed')}`, {
          success: false,
          message: t(
            '未能读取 Gmail 未读数，请确认浏览器已登录 Gmail（mail.google.com）',
            'Could not read Gmail unread. Confirm the browser is signed in to Gmail.'
          ),
          detail: acc?.error || null,
        });
      }
      refreshStatus();
    } catch (err) {
      showProbeResult(`${providerLabel} ${t('同步失败', 'sync failed')}`, { error: err.message });
    }
    return;
  }

  showProbeResult(`${t('同步', 'Sync')} ${providerLabel}`, {
    message: t('正在同步...', 'Syncing...'),
  });

  try {
    // 根据提供商选择正确的消息类型
    let msgType = 'probeContent163';
    if (provider === 'qq') msgType = 'probeContentQQ';
    else if (provider === 'ustc') msgType = 'probeContentUSTC';

    const r = await sendMessage({ type: msgType, openTab: true });

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
          showProbeResult(`${providerLabel} ${t('授权成功', 'authorized')}`, {
            ...result,
            message: `${t('授权成功，未读', 'Authorized, unread')} ${unread} ${t('封', 'msgs')}`,
          });
        } else if (needsInbox || pageType !== 'inbox') {
          showProbeResult(`${providerLabel} ${t('已授权', 'authorized')}`, {
            ...result,
            message: t(
              '已授权，请在邮箱中打开「收件箱」后读取未读数',
              'Authorized. Open the Inbox in the mailbox to read unread.'
            ),
          });
        } else {
          showProbeResult(`${providerLabel} ${t('授权成功', 'authorized')}`, { ...result });
        }
      } else {
        showProbeResult(`${providerLabel} ${t('同步失败', 'sync failed')}`, {
          ...r.probe,
          message: t(
            '未检测到登录会话，请先登录邮箱',
            'No active login session detected. Please sign in first.'
          ),
        });
      }
    } else {
      showProbeResult(`${providerLabel} ${t('同步失败', 'sync failed')}`, r?.probe || r);
    }
    refreshStatus();
  } catch (err) {
    showProbeResult(`${providerLabel} ${t('同步失败', 'sync failed')}`, { error: err.message });
  }
}

// 内容脚本探测
async function runPlanC(provider) {
  const pre = document.getElementById('probe-result-text');
  if (pre) pre.textContent = t('探测中...', 'Probing...');
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  // Gmail：无内容脚本，直接 SW 侧 Atom feed 探测（零 token、不弹授权、不开标签）
  if (provider === 'gmail') {
    if (pre) pre.textContent = t('读取未读数中...', 'Reading unread...');
    try {
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;
      if (pre) {
        showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
          success: unread != null,
          unreadCount: unread,
          authVerified: acc?.authVerified === true,
          detail:
            unread != null
              ? null
              : acc?.error ||
                t(
                  '请确认浏览器已登录 Gmail（mail.google.com）',
                  'Confirm the browser is signed in to Gmail.'
                ),
        });
      }
      refreshStatus();
    } catch (err) {
      if (pre) showProbeResult(t('获取未读数失败', 'Fetch unread failed'), { error: err.message });
    }
    return;
  }

  // 根据提供商选择正确的消息类型
  let msgType = 'probeContent163';
  if (provider === 'qq') msgType = 'probeContentQQ';
  else if (provider === 'ustc') msgType = 'probeContentUSTC';

  try {
    const r = await sendMessage({ type: msgType, openTab: true });

    const success = r?.probe?.success;
    if (pre) {
      showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
        success,
        unreadCount: r?.probe?.unreadCount ?? null,
        authVerified: r?.probe?.authVerified === true,
        detail: r?.probe?.detail || r?.error || null,
      });
    }
    refreshStatus();
  } catch (err) {
    if (pre) showProbeResult(t('获取未读数失败', 'Fetch unread failed'), { error: err.message });
  }
}

// Cookie 诊断
async function runCookieDiag() {
  showProbeResult('Cookie ' + t('诊断', 'Diagnosis'), { message: t('诊断中...', 'Diagnosing...') });
  try {
    const r = await sendMessage({ type: 'diagnoseCookies' });
    showProbeResult('🍪 Cookie ' + t('诊断', 'Diagnosis'), r);
  } catch (err) {
    showProbeResult('Cookie ' + t('诊断失败', 'diagnosis failed'), { error: err.message });
  }
}

// SW 探测
async function runSWProbe(provider) {
  const btnMap = {
    netease_163: 'btn-probe-163',
    qq: 'btn-probe-qq',
    ustc: 'btn-probe-ustc',
    gmail: 'btn-probe-gmail',
  };
  const btn = document.getElementById(btnMap[provider]);
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('探测中...', 'Probing...');
  }
  try {
    const result = await sendMessage({ type: 'testProvider', provider });
    showProbeResult(`${PROVIDER_LABELS[provider]} ${t('探测', 'probe')}`, result);
    refreshStatus();
  } catch (err) {
    showProbeResult(`${PROVIDER_LABELS[provider]} ${t('探测失败', 'probe failed')}`, {
      success: false,
      error: err.message,
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

// 检查认证
async function runCheckBridge() {
  showProbeResult(t('检查认证', 'Check auth'), { message: t('检查中...', 'Checking...') });
  try {
    const [r163, rQQ] = await Promise.all([
      sendMessage({ type: 'checkBridge', provider: 'netease_163' }),
      sendMessage({ type: 'checkBridge', provider: 'qq' }),
    ]);
    showProbeResult(t('认证状态', 'Auth status'), {
      163: { authState: r163?.authState, loggedIn: r163?.loggedIn, needsAuth: r163?.needsAuth },
      QQ: { authState: rQQ?.authState, loggedIn: rQQ?.loggedIn, needsAuth: rQQ?.needsAuth },
    });
  } catch (err) {
    showProbeResult(t('认证检查失败', 'Auth check failed'), { error: err.message });
  }
}

// 刷新会话
async function runRefreshSession() {
  showProbeResult(t('刷新会话', 'Refresh session'), { message: t('刷新中...', 'Refreshing...') });
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
    showProbeResult(t('会话刷新结果', 'Session refresh result'), results);
    refreshStatus();
  } catch (err) {
    showProbeResult(t('会话刷新失败', 'Session refresh failed'), { error: err.message });
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
  // 状态页唯一入口按钮 btn-full-check-status
  const btn = document.getElementById('btn-full-check-status');
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('⏳ 检查中...', '⏳ Checking...');
  }
  showLoading();
  try {
    const result = await sendMessage({ type: 'runCheck' });
    showProbeResult(t('全量检查结果', 'Full check result'), result);

    // Gmail 无需授权流程（Atom feed + 浏览器 Cookie）；若其检查失败，
    // 提示用户确认浏览器已登录 mail.google.com 即可（不弹窗、不开标签）。
    const gmailNeedAuth = (result?.results || []).find(
      (r) => r.provider === 'gmail' && r.needsAuth === true
    );
    if (gmailNeedAuth) {
      showProbeResult(t('全量检查', 'Full check'), {
        success: false,
        needsAuth: true,
        message: t(
          'Gmail 账户 {email} 未能读取未读数，请确认浏览器已登录 Gmail（mail.google.com）后重试',
          'Gmail account {email} could not be read. Confirm the browser is signed in to Gmail, then retry.',
          { email: gmailNeedAuth.email || t('（未授权）', '(not authorized)') }
        ),
      });
    }
    refreshStatus();
  } catch (err) {
    showProbeResult(t('全量检查失败', 'Full check failed'), { success: false, error: err.message });
  } finally {
    hideLoading();
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText || t('🚀 全量检查', '🚀 Full Check');
    }
  }
}

// 「全可能性」后台无标签测试
async function runPossibilityTest() {
  const btn = document.getElementById('btn-possibility');
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t(
      '⏳ 测试中（请耐心等待，涉及多接口）...',
      '⏳ Testing (please wait, involves many endpoints)...'
    );
  }
  showProbeResult('🧪 ' + t('全可能性后台测试', 'Possibility backend test'), {
    message: t(
      '正在逐策略探测 163/QQ 各接口，结果将输出为日志，请稍候...',
      'Probing 163/QQ endpoints strategy by strategy; results will be logged. Please wait...'
    ),
  });
  try {
    const result = await sendMessage({ type: 'possibilityTest', provider: 'all' });
    showProbeResult('🧪 ' + t('全可能性后台测试结果', 'Possibility backend test result'), result);
  } catch (err) {
    showProbeResult(t('全可能性测试失败', 'Possibility test failed'), {
      success: false,
      error: err.message,
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText || '🧪 ' + t('全可能性后台测试', 'Possibility backend test');
    }
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
  if (copyBtn) {
    copyBtn.textContent = '📋';
    copyBtn.classList.remove('copied');
  }
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
      setTimeout(() => {
        btnCopyResult.textContent = '📋';
        btnCopyResult.classList.remove('copied');
      }, 2000);
    } catch {
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
        setTimeout(() => {
          btnCopyResult.textContent = '📋';
          btnCopyResult.classList.remove('copied');
        }, 2000);
      } catch {
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
      container.innerHTML = `<div class="empty">${t('暂无日志', 'No logs')}</div>`;
      return;
    }
    container.innerHTML = debugLogs
      .slice(0, 100)
      .map((log) => {
        const cls = (log.level || 'info').toLowerCase();
        const detail = log.detail ? `<br><small>${escapeHtml(log.detail)}</small>` : '';
        return `<div class="${cls}">[${new Date(log.ts).toLocaleTimeString()}] [${log.level}] [${escapeHtml(log.module)}] ${escapeHtml(log.message)}${detail}</div>`;
      })
      .join('');
  } catch (err) {
    const container = document.getElementById('logs-container');
    if (container) {
      container.innerHTML = `<div class="error">${t('读取日志失败', 'Failed to read logs')}: ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function fetchLogsFromStorage(limit = 100) {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    return Array.isArray(debugLogs) ? debugLogs.slice(0, limit) : [];
  } catch {
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
  return logs
    .map((log) => {
      const t = new Date(log.ts).toLocaleTimeString();
      const detail = log.detail ? `\n${log.detail}` : '';
      return `[${t}] [${log.level}] [${log.module}] ${log.message}${detail}`;
    })
    .join('\n');
}

async function copyLogs() {
  const copyBtn = document.getElementById('btn-copy-logs');
  if (!copyBtn) return;
  const logs = await fetchLogsFromStorage();
  const text = logsToPlainText(logs);
  if (!text) {
    copyBtn.textContent = '❌ ' + t('无日志', 'no logs');
    setTimeout(() => {
      copyBtn.textContent = '📋 ' + t('复制', 'Copy');
    }, 2000);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = '✅ ' + t('已复制', 'copied');
    copyBtn.classList.add('copied');
  } catch {
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
    copyBtn.textContent = ok ? '✅ ' + t('已复制', 'copied') : '❌ ' + t('复制失败', 'copy failed');
    copyBtn.classList.toggle('copied', ok);
  }
  setTimeout(() => {
    copyBtn.textContent = '📋 ' + t('复制', 'Copy');
    copyBtn.classList.remove('copied');
  }, 2000);
}

async function clearLogs() {
  const clearBtn = document.getElementById('btn-clear-logs');
  if (!clearBtn) return;
  try {
    await chrome.storage.session.remove('debugLogs');
    document.getElementById('logs-container').innerHTML =
      `<div class="empty">${t('暂无日志', 'No logs')}</div>`;
    clearBtn.textContent = '✅ ' + t('已清除', 'cleared');
    setTimeout(() => {
      clearBtn.textContent = '🗑 ' + t('清除', 'Clear');
    }, 2000);
  } catch {
    clearBtn.textContent = '❌ ' + t('清除失败', 'clear failed');
    setTimeout(() => {
      clearBtn.textContent = '🗑 ' + t('清除', 'Clear');
    }, 2000);
  }
}

// 复制 / 清除日志
document.getElementById('btn-copy-logs')?.addEventListener('click', copyLogs);
document.getElementById('btn-clear-logs')?.addEventListener('click', clearLogs);
// ========== 公共工具 ==========
/**
 * 统一的 SW 消息发送入口。
 *
 * Popup 只能在用户主动打开（点击浏览器工具栏图标/按钮）时存在与交互，
 * 因此凡是这里发出的消息都带一个**显式的手动触发标识** trigger='manual'：
 *   - 手动来源允许走完整交互流程（打开邮箱页、复用标签、弹出 Gmail 授权窗）；
 *   - 自动来源（后台定时 alarm、页面事件等）由 SW 端发起、不会经此入口，
 *     故天然带不上 manual 标识，从而保证「自动绝不擅自弹窗/开标签」。
 * 这个标识即 AGENTS 规则 1 里「用户主动显式触发」与「后台被动触发」的分界。
 */
function sendMessage(message) {
  const payload = { ...message, trigger: 'manual' };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
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

// ========== 界面语言 ==========
async function syncLanguageSelect() {
  const sel = document.getElementById('language-select');
  if (!sel) return;
  const pref = await getStoredLanguage();
  sel.value = pref === 'zh' || pref === 'en' ? pref : 'auto';
}

// ========== 报告 Bug（反馈至 lazebird@gmail.com）==========
// 用户点击「打开邮件报告 Bug」后，组装一份精简诊断文本（版本 + 浏览器语言 + 各账户状态摘要 +
// 最近少量日志），经 background 用 chrome.tabs.create 打开 mailto，交给系统邮件客户端处理。
//
// 【400 根因】mailto 携带过长正文（尤其全量 JSON 状态 + 上百条日志）会超过浏览器/邮件客户端对
// mailto URL 的长度限制，被直接拒绝返回 Bad Request / Error 400。因此这里：
//   1) 正文只取精简摘要（不整包 dump 全部状态/日志），逐账户一行；
//   2) 对整体长度做硬性截断，保证编码后 mailto URL 远低于安全阈值。
// 仍保持单按钮、手动触发；mailto 唤起由 background 的 chrome.tabs.create 完成，仅用户点击允许，
// 符合 AGENTS 规则 1「用户主动操作允许开标签」。

// mailto URL 安全长度上限（保守取较低值，避开浏览器/邮件客户端限制）
const MAILTO_SAFE_LENGTH = 1800;
// 截断标记
const MAILTO_TRUNCATED_MARK = '\n\n...[内容已截断]';

/** 把一个账户的状态渲染为单行摘要 */
function summarizeAccount(acc) {
  const flags = [];
  if (acc.authVerified === true) flags.push('OK');
  if (acc.needsAuth === true) flags.push('需授权');
  if (acc.needsInboxPage === true) flags.push('需打开收件箱');
  if (typeof acc.unreadCount === 'number') flags.push('unread=' + acc.unreadCount);
  if (acc.method) flags.push(acc.method);
  const statusLine = flags.length ? flags.join(', ') : acc.error || '';
  const err = acc.error ? ' | err=' + acc.error : '';
  return '[' + (acc.provider || '?') + '] ' + (acc.email || '?') + ' :: ' + statusLine + err;
}

/** 收集精简诊断文本：版本 + 浏览器语言 + 账户状态摘要 + 最近少量日志 */
async function collectBugReport() {
  const parts = [];
  parts.push(t('扩展版本: ', 'Extension version: ') + (chrome.runtime.getManifest().version || ''));
  parts.push(t('浏览器语言: ', 'Browser language: ') + (navigator.language || ''));
  parts.push('');

  try {
    const status = await sendMessage({ type: 'getStatus' });
    const accs = status?.accountStatus || [];
    parts.push('--- ' + t('账户状态', 'Account status') + ' ---');
    if (accs.length) {
      accs.forEach((a) => parts.push(summarizeAccount(a)));
    } else {
      parts.push(t('（无账户）', '(no accounts)'));
    }
  } catch (e) {
    parts.push('getStatus failed: ' + e.message);
  }
  parts.push('');

  // 最近日志：只取少量且做单行精简，避免过长 detail 撑爆 mailto
  try {
    const logs = await getLogsAPI(40);
    const lines = logsToPlainText(logs)
      .split('\n')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    parts.push('--- ' + t('最近日志', 'Recent logs') + ' ---');
    parts.push(lines.length ? lines.slice(-30).join('\n') : t('（无日志）', '(no logs)'));
  } catch (e) {
    parts.push('getLogs failed: ' + e.message);
  }
  return parts.join('\n');
}

/** 组装 mailto：先构建正文，再对 URL 总长做安全截断（截掉旧内容并保留头尾标记） */
function buildMailtoUrl(report) {
  const subject =
    t('[Mail Notifier] Bug 反馈', '[Mail Notifier] Bug report') +
    ' v' +
    chrome.runtime.getManifest().version;
  const prefix = 'mailto:lazebird@gmail.com?subject=' + encodeURIComponent(subject) + '&body=';

  // 若整体 URL 已超安全长度，则从正文尾部逐行移除（日志在末尾，先裁日志）
  // 直至达标，并附加截断标记；仍超长时再做字符级硬截断。
  let body = report;
  let url = prefix + encodeURIComponent(body);
  const lines = body.split('\n');
  while (url.length > MAILTO_SAFE_LENGTH && lines.length > 1) {
    lines.pop(); // 去掉最后一行（最旧/多余日志）
    body = lines.join('\n');
    url = prefix + encodeURIComponent(body + MAILTO_TRUNCATED_MARK);
  }
  if (url.length > MAILTO_SAFE_LENGTH) {
    // 仍超长则做字符级硬截断（保留下半部分标志说明）
    const tail = MAILTO_TRUNCATED_MARK;
    let cut = body;
    let remaining = MAILTO_SAFE_LENGTH - prefix.length - encodeURIComponent(tail).length;
    while (remaining > 0 && encodeURIComponent(cut).length > remaining) {
      cut = cut.slice(0, Math.max(0, cut.length - 16));
    }
    url = prefix + encodeURIComponent(cut + tail);
  }
  return url;
}

/** 报告 Bug：经 background 稳定唤起邮件客户端（用户手动点击） */
async function reportBugByEmail() {
  const btn = document.getElementById('btn-report-bug');
  if (btn) btn.disabled = true;
  try {
    const report = await collectBugReport();
    const mailto = buildMailtoUrl(report);
    const res = await sendMessage({ type: 'openReportEmail', url: mailto });
    if (res?.success === false) {
      showSaveStatus(t('打开邮件失败: ', 'Failed to open email: ') + (res.error || ''), 'error');
      return;
    }
    showSaveStatus(
      t(
        '✅ 邮件客户端已唤起，请在正文补充问题描述后点发送（收件人 lazebird@gmail.com）。若未弹出，请检查浏览器默认邮件应用。',
        '✅ Mail app opened. Add a description and send (to lazebird@gmail.com). If nothing popped up, check your browser default mail app.'
      ),
      'success'
    );
  } catch (err) {
    console.error('报告 Bug 失败:', err);
    showSaveStatus(t('报告 Bug 失败: ', 'Failed to report bug: ') + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  // 应用语言偏好（auto→浏览器语言；或用户在设置中显式选择）
  await applyLanguage();
  applyDomI18n();
  await syncLanguageSelect();

  // 折叠面板
  setupCollapse('btn-toggle-advanced', 'advanced-probe');
  setupCollapse('btn-toggle-endpoints', 'endpoint-config');

  // 探测标签页 - 内容脚本探测
  document
    .getElementById('btn-content-163')
    ?.addEventListener('click', () => runPlanC('netease_163'));
  document.getElementById('btn-content-qq')?.addEventListener('click', () => runPlanC('qq'));
  document.getElementById('btn-content-ustc')?.addEventListener('click', () => runPlanC('ustc'));
  document.getElementById('btn-content-gmail')?.addEventListener('click', () => runPlanC('gmail'));

  // 同步会话
  document
    .getElementById('btn-sync-163')
    ?.addEventListener('click', () => syncSession('netease_163'));
  document.getElementById('btn-sync-qq')?.addEventListener('click', () => syncSession('qq'));
  document.getElementById('btn-sync-ustc')?.addEventListener('click', () => syncSession('ustc'));
  document.getElementById('btn-sync-gmail')?.addEventListener('click', () => syncSession('gmail'));

  // 全量检查（状态页）
  document.getElementById('btn-full-check-status')?.addEventListener('click', runFullCheck);

  // Cookie 诊断
  document.getElementById('btn-diagnose-cookies')?.addEventListener('click', runCookieDiag);

  // 高级探测
  document
    .getElementById('btn-probe-163')
    ?.addEventListener('click', () => runSWProbe('netease_163'));
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

  // 语言选择：立即切换并重绘当前可见页面
  document.getElementById('language-select')?.addEventListener('change', async (e) => {
    const pref = e.target.value || LANGUAGES.AUTO;
    await setStoredLanguage(pref);
    await applyLanguage();
    applyDomI18n();
    // 重绘动态渲染的可见标签页
    if (isTabVisible('overview')) refreshStatus();
    if (isTabVisible('settings')) loadSettingsPanel();
    if (isTabVisible('stats')) refreshStatus();
    if (isTabVisible('logs')) refreshLogs();
    showSaveStatus(t('语言已切换', 'Language changed'), 'success');
  });

  // 报告 Bug：用户手动点击 → 组装诊断并唤起邮件客户端发送至 lazebird@gmail.com
  document.getElementById('btn-report-bug')?.addEventListener('click', reportBugByEmail);

  // 初始化刷新状态
  refreshStatus();

  // 暴露日志获取 API（供 Playwright 等外部工具调用）
  window.getMailNotifierLogs = async (limit = 100) => {
    return await getLogsAPI(limit);
  };
});
