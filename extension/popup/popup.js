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
// 普通账户走被动探测；Gmail 走「读缓存令牌 → 未授权则弹交互授权 → 再探测」链路，
// 让状态页 Gmail 的「检查」在未授权时也能真正把令牌拿下来（用户主动点击，符合 AGENTS 规则 1）。
async function checkAccountCard(provider, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (provider === 'gmail') {
      // 1) 先被动探测：仅读缓存令牌，不开标签 / 不弹窗
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;

      // 是否已持有有效 Gmail 令牌（来自当前状态，hasSid 对 gmail 即令牌存在性）
      const status = await sendMessage({ type: 'getStatus' });
      const accSt = status?.accountStatus?.find((a) => a.provider === 'gmail');
      const hasToken = accSt?.hasSid === true;

      // 2) 已读到未读数 → 成功，无需处理
      // 3) 未读到未读数：
      //    a) 无有效令牌（未授权）→ 用户主动点击，弹交互授权拿令牌后重新探测
      //    b) 已有有效令牌但 API 探测失败（如 Gmail API 未启用 / 配额受限）→
      //       重授权无济于事，直接展示具体原因，避免「授权→再失败→又弹窗」的死循环
      if (unread == null) {
        if (!hasToken) {
          const auth = await sendMessage({ type: 'gmailAuthorize' });
          if (auth?.success) {
            await sendMessage({ type: 'testProvider', provider: 'gmail' });
          } else {
            // 授权未成功：把具体原因展示出来，避免状态页只停留在「需授权」却无任何线索
            showProbeResult(t('Gmail 授权未完成', 'Gmail authorization incomplete'), {
              success: false,
              message: t(
                'Gmail 授权失败或已取消，请检查下方原因后重试',
                'Gmail authorization failed or cancelled. Check the details below and retry.'
              ),
              error: auth?.error || t('未知原因', 'unknown reason'),
              needsManual: auth?.needsManual === true,
            });
          }
        } else {
          // 已有有效令牌但仍未读到未读数：展示 API 返回的具体原因，不再重复弹授权
          showProbeResult(t('Gmail 检查失败', 'Gmail check failed'), {
            success: false,
            message: t(
              '已持有 Gmail 授权令牌，但未能读取未读数',
              'Has a Gmail token but could not read unread'
            ),
            error: acc?.error || t('请检查下方原因后处理', 'Check the reason below'),
            hint: t(
              '若提示 Gmail API 访问受限，请到 Google Cloud 控制台确认已启用 Gmail API，并核对授权重定向 URI。',
              'If Gmail API access is restricted, enable Gmail API in the Google Cloud console and verify the OAuth redirect URI.'
            ),
          });
        }
      }
    } else {
      await sendMessage({ type: 'testProvider', provider });
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
    [t('Gmail API 模式', 'Gmail API patterns'), `${status.apiPatternCounts?.gmail || 0}`],
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
// 同步会话
async function syncSession(provider) {
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  showProbeResult(`${t('同步', 'Sync')} ${providerLabel}`, {
    message: t('正在同步...', 'Syncing...'),
  });

  try {
    // 根据提供商选择正确的消息类型
    let msgType = 'probeContent163';
    if (provider === 'qq') msgType = 'probeContentQQ';
    else if (provider === 'ustc') msgType = 'probeContentUSTC';
    else if (provider === 'gmail') msgType = 'gmailAuthorize';

    const r = await sendMessage({ type: msgType, openTab: true });

    // Gmail 走 OAuth2 授权，返回扁平结果 { success, token }，无 probe 字段。
    if (provider === 'gmail' && r?.success) {
      showProbeResult(`${providerLabel} ${t('授权成功', 'authorized')}`, {
        success: true,
        message: t('Gmail 授权成功，正在读取未读数...', 'Gmail authorized, reading unread...'),
      });
      // 授权完成后触发一次后台探测，读取未读数
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      const unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;
      showProbeResult(`${providerLabel} ${t('授权成功', 'authorized')}`, {
        success: true,
        authVerified: acc?.authVerified === true,
        unreadCount: unread,
        message:
          unread != null
            ? `${t('授权成功，未读', 'Authorized, unread')} ${unread} ${t('封', 'msgs')}`
            : acc?.needsAuth
              ? t(
                  '已授权但未能读取未读数，请稍后重试',
                  'Authorized but failed to read unread; retry later'
                )
              : t('Gmail 授权成功', 'Gmail authorized'),
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

  // 根据提供商选择正确的消息类型
  let msgType = 'probeContent163';
  if (provider === 'qq') msgType = 'probeContentQQ';
  else if (provider === 'ustc') msgType = 'probeContentUSTC';
  else if (provider === 'gmail') msgType = 'gmailAuthorize';

  try {
    // Gmail：不走开头的 gmailAuthorize（避免每次探测都先弹授权窗）。改为先被动探测，
    // 仅当确认没有有效令牌时，才由用户主动点击触发交互授权（AGENTS 规则 1）。
    const r = provider === 'gmail' ? null : await sendMessage({ type: msgType, openTab: true });

    // Gmail：先直接后台探测（读缓存令牌）；未授权/令牌失效时引导交互授权
    if (provider === 'gmail') {
      if (pre) pre.textContent = t('读取未读数中...', 'Reading unread...');
      const probe = await sendMessage({ type: 'testProvider', provider: 'gmail' });
      const acc = probe?.results?.[0];
      let unread = acc && typeof acc.unreadCount === 'number' ? acc.unreadCount : null;

      // 是否已持有有效 Gmail 令牌（无令牌 → 需授权；有令牌但探测失败 → 展示原因，不重复弹窗）
      const st = await sendMessage({ type: 'getStatus' });
      const accSt = st?.accountStatus?.find((a) => a.provider === 'gmail');
      const hasToken = accSt?.hasSid === true;

      if (unread == null && !hasToken) {
        // 无有效令牌 → 弹交互授权（仅用户主动点击时）
        showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
          success: false,
          message: t(
            'Gmail 未授权，正在弹出授权窗口，请在弹出的 Google 页面中确认...',
            'Gmail not authorized. Opening the authorization window; confirm on the Google page...'
          ),
        });
        const auth = await sendMessage({ type: 'gmailAuthorize' });
        if (auth?.success) {
          if (pre)
            pre.textContent = t('授权成功，读取未读数中...', 'Authorized, reading unread...');
          const probe2 = await sendMessage({ type: 'testProvider', provider: 'gmail' });
          const acc2 = probe2?.results?.[0];
          unread = acc2 && typeof acc2.unreadCount === 'number' ? acc2.unreadCount : null;
          if (pre) {
            showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
              success: unread != null,
              unreadCount: unread,
              authVerified: acc2?.authVerified === true,
              detail: acc2?.error || null,
            });
          }
        } else {
          if (pre)
            showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
              success: false,
              message: t('Gmail 授权未完成或已取消', 'Gmail authorization incomplete or cancelled'),
              error: auth?.error || null,
            });
        }
        refreshStatus();
        return;
      }

      if (pre) {
        showProbeResult(`${t('获取未读数', 'Fetch unread')} · ${providerLabel}`, {
          success: unread != null,
          unreadCount: unread,
          authVerified: acc?.authVerified === true,
          message:
            unread != null
              ? undefined
              : hasToken
                ? t(
                    '已持有 Gmail 授权令牌，但未能读取未读数',
                    'Has a Gmail token but could not read unread'
                  )
                : t('Gmail 未读取到未读数', 'Gmail returned no unread'),
          detail: acc?.error || null,
          hint:
            unread == null && hasToken
              ? t(
                  '若提示 Gmail API 访问受限，请到 Google Cloud 控制台确认已启用 Gmail API，并核对授权重定向 URI。',
                  'If Gmail API access is restricted, enable Gmail API in the Google Cloud console and verify the OAuth redirect URI.'
                )
              : undefined,
        });
      }
      refreshStatus();
      return;
    }

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

    // 手动点击「全量检查」按钮同样属用户主动显式操作（AGENTS 规则 1 允许弹授权）。
    // 若任一 Gmail 账户需要授权（无有效令牌），应一并弹出 OAuth 授权窗，授权成功后
    // 再重跑一次全量，把 Gmail 的未读数也纳入结果，避免「需授权」却无从处理。
    const gmailNeedAuth = (result?.results || []).find(
      (r) => r.provider === 'gmail' && r.needsAuth === true
    );
    if (gmailNeedAuth) {
      showProbeResult(t('全量检查', 'Full check'), {
        success: false,
        needsAuth: true,
        message: t(
          'Gmail 账户 {email} 需要授权，正在弹出 Google 授权窗口，请在弹出的页面中确认...',
          'Gmail account {email} needs authorization. Opening the Google authorization window; confirm on the page...',
          { email: gmailNeedAuth.email || t('（未授权）', '(not authorized)') }
        ),
      });
      const auth = await sendMessage({ type: 'gmailAuthorize' });
      if (auth?.success) {
        // 授权成功：重跑全量，让刚授权的 Gmail 也能读到未读数
        const result2 = await sendMessage({ type: 'runCheck' });
        showProbeResult(t('全量检查结果', 'Full check result'), result2);
      } else {
        showProbeResult(t('Gmail 授权未完成', 'Gmail authorization incomplete'), {
          success: false,
          message: t(
            'Gmail 授权失败或已取消，请检查下方原因后重试',
            'Gmail authorization failed or cancelled. Check the details below and retry.'
          ),
          error: auth?.error || t('未知原因', 'unknown reason'),
          needsManual: auth?.needsManual === true,
        });
      }
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
// 说明：诊断内容（账户状态 + 日志）可能较长，若塞入 mailto 的 body 会超出 URL 长度
// 限制而被邮件客户端拒绝（HTTP 400）。因此这里改用「复制完整报告到剪贴板 + 打开
// 短正文 mailto」的组合：完整内容始终随剪贴板保留，用户粘贴到任意邮件即可发送；
// 即使本机未配置邮件客户端，复制内容也能作为可靠兜底。

/** 读取用户填写的问题描述（可选） */
function readBugDescription() {
  const ta = document.getElementById('bug-desc');
  return ta ? ta.value.trim() : '';
}

/** 收集诊断报告文本：问题描述 + 扩展版本 + 账户状态 + 最近日志 */
async function collectBugReport() {
  let statusText = '';
  try {
    const status = await sendMessage({ type: 'getStatus' });
    statusText = JSON.stringify(
      {
        accounts: status?.accounts || [],
        accountStatus: status?.accountStatus || [],
        settings: status?.settings || {},
      },
      null,
      2
    );
  } catch (e) {
    statusText = 'getStatus failed: ' + e.message;
  }

  let logsText = '';
  try {
    const logs = await getLogsAPI(200);
    logsText = logsToPlainText(logs) || t('（无日志）', '(no logs)');
  } catch (e) {
    logsText = 'getLogs failed: ' + e.message;
  }

  const description = readBugDescription() || t('（未填写）', '(not provided)');
  return [
    t('扩展版本: ', 'Extension version: ') + (chrome.runtime.getManifest().version || ''),
    t('浏览器语言: ', 'Browser language: ') + (navigator.language || ''),
    '',
    '--- ' + t('问题描述', 'Issue description') + ' ---',
    description,
    '',
    '--- ' + t('账户状态', 'Account status') + ' ---',
    statusText,
    '',
    '--- ' + t('最近日志', 'Recent logs') + ' ---',
    logsText,
  ].join('\n');
}

/** 复制文本到剪贴板；Clipboard API 不可用时回退 execCommand */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** 打开一个短正文的 mailto，避免超长 body 触发 400 */
function openMailToShort() {
  const subject = t('[Mail Notifier] Bug 反馈', '[Mail Notifier] Bug report');
  // body 仅作简短指引，完整诊断内容已写入剪贴板，用户在邮件正文粘贴即可
  const body = t(
    '完整诊断报告已复制到剪贴板，请直接粘贴到本邮件正文后发送。\n（若邮件应用未自动打开，可新建邮件并粘贴。）',
    'Full diagnostics have been copied to your clipboard. Paste them into the body of this email and send.\n(If your mail app did not open, create a new email and paste.)'
  );
  const mailto =
    'mailto:lazebird@gmail.com?subject=' +
    encodeURIComponent(subject) +
    '&body=' +
    encodeURIComponent(body);
  // 用户主动点击（符合 AGENTS 规则 1：允许打开页面/客户端）
  const a = document.createElement('a');
  a.href = mailto;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 复制完整报告到剪贴板（可靠后备，不依赖邮件客户端） */
async function copyBugReport() {
  const btn = document.getElementById('btn-copy-report');
  if (btn) btn.disabled = true;
  try {
    const report = await collectBugReport();
    const ok = await copyTextToClipboard(report);
    if (ok) {
      showSaveStatus(
        t(
          '✅ 完整诊断报告已复制，请粘贴到邮件中发送至 lazebird@gmail.com',
          '✅ Full report copied. Paste it into an email to lazebird@gmail.com.'
        ),
        'success'
      );
    } else {
      showSaveStatus(
        t(
          '❌ 复制失败，请改用下方“生成邮件”按钮',
          '❌ Copy failed. Use the Compose button below instead.'
        ),
        'error'
      );
    }
  } catch (err) {
    console.error('复制报告失败:', err);
    showSaveStatus(t('复制报告失败: ', 'Failed to copy report: ') + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 报告 Bug：复制完整报告到剪贴板并打开短正文邮件客户端 */
async function reportBugByEmail() {
  try {
    const report = await collectBugReport();
    await copyTextToClipboard(report);
    openMailToShort();
    showProbeResult(
      t('报告已复制，请发送邮件', 'Report copied, please send email'),
      t(
        '✅ 完整诊断信息已复制到剪贴板。邮件客户端（若已配置）已打开，请把内容粘贴到正文后发送至 lazebird@gmail.com；若未弹出邮件应用，请新建邮件并粘贴复制内容发送。',
        '✅ Full diagnostics copied to clipboard. Your mail client (if configured) should open; paste the content into the body and send to lazebird@gmail.com. If no mail app opened, create an email and paste the copied content.'
      )
    );
  } catch (err) {
    console.error('报告 Bug 失败:', err);
    showSaveStatus(t('报告 Bug 失败: ', 'Failed to report bug: ') + err.message, 'error');
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

  // 报告 Bug：复制报告到剪贴板 / 打开邮件客户端发送至 lazebird@gmail.com
  document.getElementById('btn-report-bug')?.addEventListener('click', reportBugByEmail);
  document.getElementById('btn-copy-report')?.addEventListener('click', copyBugReport);

  // 初始化刷新状态
  refreshStatus();

  // 暴露日志获取 API（供 Playwright 等外部工具调用）
  window.getMailNotifierLogs = async (limit = 100) => {
    return await getLogsAPI(limit);
  };
});
