/**
 * options.js - 设置页逻辑
 *
 * 优化：
 * 1. 添加会话状态检查和刷新按钮
 * 2. 更清晰的账户管理
 * 3. 更健壮的错误处理
 */

const PROVIDER_LABELS = {
  netease_163: '163邮箱',
  qq: 'QQ邮箱',
  ustc: '中科大',
  gmail: 'Gmail',
};

// 各提供商可选的探测接口
const ENDPOINT_OPTIONS = {
  netease_163: [
    { name: 'js6_rpc', label: 'js6 RPC 网关 (mbox:listMessages)' },
    { name: 'js6_rpc2', label: 'js6 网关 (mbox:getUnread)' },
    { name: 'unread_count', label: '轻量未读计数接口' },
  ],
  qq: [
    { name: 'cgi_mail_list', label: 'cgi-bin/mail_list (收件箱列表)' },
    { name: 'cgi_fr_show', label: 'cgi-bin/fr_show (轻量未读)' },
  ],
};

let currentAccounts = [];
let currentSettings = {};

async function init() {
  try {
    // 加载账户
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    currentAccounts = Array.isArray(accounts) ? accounts : [];

    // 加载设置
    const { settings = {} } = await chrome.storage.local.get('settings');
    currentSettings = { ...settings };

    renderAccounts();
    renderSettings();
    renderEndpoints();
    renderSessionStatus();
  } catch (err) {
    showStatus(`初始化失败: ${err.message}`, 'error');
  }
}

function renderAccounts() {
  const list = document.getElementById('accounts-list');

  if (!currentAccounts.length) {
    list.innerHTML = '<div class="help-text">暂无账户，请先在下方添加。添加邮箱账户后，需确保在浏览器中已登录对应邮箱网页。</div>';
  } else {
    list.innerHTML = '';
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';

    currentAccounts.forEach((acc, idx) => {
      const li = document.createElement('li');
      li.className = 'account-item';
      li.innerHTML = `
        <div class="account-info">
          <strong>${escapeHtml(acc.email)}</strong>
          <span style="color:#6c757d;font-size:12px;margin-left:8px;">${PROVIDER_LABELS[acc.provider] || acc.provider}</span>
          <span style="color:#adb5bd;font-size:11px;margin-left:8px;">${new Date(acc.addedAt || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="account-actions">
          <button onclick="testAccount(${idx})" class="secondary">测试</button>
          <button onclick="removeAccount(${idx})" class="danger">删除</button>
        </div>
      `;
      ul.appendChild(li);
    });
    list.appendChild(ul);
  }
}

function renderSettings() {
  const intervalSelect = document.getElementById('interval-select');
  const logLevelSelect = document.getElementById('loglevel-select');

  if (currentSettings.checkIntervalMinutes) {
    intervalSelect.value = String(currentSettings.checkIntervalMinutes);
  }
  if (currentSettings.logLevel) {
    logLevelSelect.value = currentSettings.logLevel;
  }
}

function renderEndpoints() {
  const container = document.getElementById('endpoint-config');

  const providers = Object.keys(ENDPOINT_OPTIONS);
  const sections = providers.map(provider => {
    const endpoints = ENDPOINT_OPTIONS[provider];
    const enabled = currentSettings.enabledEndpoints?.[provider] || [];

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
      <div style="margin-bottom:12px;">
        <div style="font-weight:600;font-size:14px;margin-bottom:6px;">${PROVIDER_LABELS[provider] || provider}</div>
        ${checks}
      </div>
    `;
  }).join('');

  container.innerHTML = sections;
}

async function renderSessionStatus() {
  // 检查各提供商的会话状态
  const container = document.getElementById('session-status');
  if (!container) return;

  container.innerHTML = '<div class="help-text">正在检查会话状态...</div>';

  try {
    const [r163, rQQ] = await Promise.all([
      sendSWMessage({ type: 'checkBridge', provider: 'netease_163' }).catch(() => ({ loggedIn: false })),
      sendSWMessage({ type: 'checkBridge', provider: 'qq' }).catch(() => ({ loggedIn: false })),
    ]);

    const status163 = r163?.loggedIn ? '✅ 已登录' : '❌ 未登录';
    const statusQQ = rQQ?.loggedIn ? '✅ 已登录' : '❌ 未登录';

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
        <div>
          <strong>163邮箱</strong>
          <span class="provider-status ${r163?.loggedIn ? 'status-ok' : 'status-fail'}" style="margin-left:8px;">${status163}</span>
        </div>
        <div>
          <strong>QQ邮箱</strong>
          <span class="provider-status ${rQQ?.loggedIn ? 'status-ok' : 'status-fail'}" style="margin-left:8px;">${statusQQ}</span>
        </div>
        <button onclick="refreshAllSessions()" class="secondary" style="font-size:12px;padding:4px 8px;">🔄 刷新会话</button>
      </div>
      <div class="hint" style="font-size:12px;color:#6c757d;margin-top:4px;">
        会话基于浏览器中已登录的邮箱网页状态。如探测失败，请先在浏览器中打开邮箱并登录，然后点击"刷新会话"。
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="help-text">会话状态检查失败: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshAllSessions() {
  const container = document.getElementById('session-status');
  if (container) {
    container.innerHTML = '<div class="help-text">正在刷新会话...</div>';
  }

  try {
    const results = {};
    for (const provider of ['netease_163', 'qq']) {
      const r = await sendSWMessage({ type: 'refreshSession', provider });
      results[provider] = r?.loggedIn ? '✅ 已登录' : '❌ 未登录';
    }
    showStatus(`会话刷新完成: 163=${results.netease_163}, QQ=${results.qq}`, 'success');
    await renderSessionStatus();
  } catch (err) {
    showStatus(`会话刷新失败: ${err.message}`, 'error');
    await renderSessionStatus();
  }
}

async function addAccount() {
  const provider = document.getElementById('provider-select').value;
  const email = document.getElementById('email-input').value.trim();

  if (!email) {
    alert('请输入邮箱地址');
    return;
  }

  // 简单验证邮箱格式
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert('邮箱格式不正确');
    return;
  }

  // 检查是否已存在相同账户
  if (currentAccounts.some(a => a.email === email && a.provider === provider)) {
    showStatus('该账户已存在', 'error');
    return;
  }

  currentAccounts.push({
    email,
    provider,
    addedAt: new Date().toISOString(),
  });

  await chrome.storage.local.set({ accounts: currentAccounts });
  renderAccounts();
  document.getElementById('email-input').value = '';
  notifySWAccountsChanged();

  showStatus('账户添加成功', 'success');
}

async function removeAccount(index) {
  currentAccounts.splice(index, 1);
  await chrome.storage.local.set({ accounts: currentAccounts });
  renderAccounts();
  showStatus('账户已删除', 'success');
  notifySWAccountsChanged();
}

function notifySWAccountsChanged() {
  try {
    chrome.runtime.sendMessage({ type: 'accountsChanged' });
  } catch (e) {
    // SW 可能不在线，忽略
  }
}

function sendSWMessage(message) {
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

async function testAccount(index) {
  const account = currentAccounts[index];
  if (!account) return;

  try {
    const result = await sendSWMessage({
      type: 'testProvider',
      provider: account.provider,
    });

    const providerLabel = PROVIDER_LABELS[account.provider] || account.provider;
    const authVerified = result?.results?.[0]?.authVerified ||
                         result?.results?.[0]?.session?.loggedIn;
    const unreadCount = findUnreadFromResult(result);
    const msg = authVerified
      ? `${providerLabel} 认证成功${unreadCount !== null ? `，未读: ${unreadCount}` : ''}`
      : `${providerLabel} 认证失败，可能需要登录邮箱网页`;

    showStatus(msg, authVerified ? 'success' : 'error');
  } catch (err) {
    showStatus(`测试失败: ${err.message}`, 'error');
  }
}

function findUnreadFromResult(result) {
  try {
    const accountResult = result?.results?.[0];
    if (!accountResult) return null;
    for (const epResult of accountResult.results || []) {
      if (typeof epResult.unreadCount === 'number') {
        return epResult.unreadCount;
      }
    }
  } catch (e) {}
  return null;
}

async function saveSettings() {
  const interval = parseInt(document.getElementById('interval-select').value, 10);
  const logLevel = document.getElementById('loglevel-select').value;

  // 收集接口启用状态
  const enabledEndpoints = {};
  document.querySelectorAll('input[type="checkbox"][data-provider]').forEach(cb => {
    const provider = cb.dataset.provider;
    const endpoint = cb.dataset.endpoint;

    if (!enabledEndpoints[provider]) enabledEndpoints[provider] = [];
    if (cb.checked) {
      enabledEndpoints[provider].push(endpoint);
    }
  });

  // 确保每个提供商至少启用一个接口
  for (const provider of Object.keys(ENDPOINT_OPTIONS)) {
    if (!enabledEndpoints[provider] || enabledEndpoints[provider].length === 0) {
      const firstEndpoint = ENDPOINT_OPTIONS[provider][0];
      enabledEndpoints[provider] = [firstEndpoint.name];
    }
  }

  currentSettings = {
    ...currentSettings,
    checkIntervalMinutes: interval,
    logLevel,
    enabledEndpoints,
  };

  await chrome.storage.local.set({ settings: currentSettings });

  // 通知 SW 重新注册闹钟
  try {
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
  } catch (e) {
    // SW 可能不在线，忽略
  }

  showStatus('设置已保存', 'success');
}

async function resetSettings() {
  if (!confirm('确定要重置所有设置吗？所有账户配置将被清除。')) return;

  await chrome.storage.local.clear();
  currentAccounts = [];
  currentSettings = {};
  await init();
  showStatus('已重置所有设置', 'success');
}

function showStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = `save-status ${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// 暴露全局函数供 onclick 调用
window.addAccount = addAccount;
window.removeAccount = removeAccount;
window.testAccount = testAccount;
window.saveSettings = saveSettings;
window.resetSettings = resetSettings;
window.refreshAllSessions = refreshAllSessions;

// 事件绑定
document.addEventListener('DOMContentLoaded', () => {
  const btnAdd = document.getElementById('btn-add-account');
  const emailInput = document.getElementById('email-input');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');

  if (btnAdd) btnAdd.addEventListener('click', addAccount);
  if (emailInput) {
    emailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addAccount();
    });
  }
  if (btnSave) btnSave.addEventListener('click', saveSettings);
  if (btnReset) btnReset.addEventListener('click', resetSettings);
});

// 初始化
init();
