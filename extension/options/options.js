/**
 * options.js - 设置页逻辑
 */

// 加载配置
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
  ],
  qq: [
    { name: 'cgi_mail_list', label: 'cgi-bin/mail_list' },
    { name: 'cgi_readdata', label: 'cgi-bin/readdata' },
  ],
};

let currentAccounts = [];
let currentSettings = {};

async function init() {
  // 加载账户
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  currentAccounts = accounts;

  // 加载设置
  const { settings = {} } = await chrome.storage.local.get('settings');
  currentSettings = { ...settings };

  renderAccounts();
  renderSettings();
  renderEndpoints();
}

function renderAccounts() {
  const container = document.getElementById('accounts-list');
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

  currentAccounts.push({
    email,
    provider,
    addedAt: new Date().toISOString(),
  });

  await chrome.storage.local.set({ accounts: currentAccounts });
  renderAccounts();
  document.getElementById('email-input').value = '';
  notifySWAccountsChanged();

  // 显示添加成功的提示
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

async function testAccount(index) {
  const account = currentAccounts[index];
  if (!account) return;

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'testProvider',
        provider: account.provider,
      }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });

    const providerLabel = PROVIDER_LABELS[account.provider] || account.provider;
    showStatus(`${providerLabel} 探测完成: ${JSON.stringify(result)?.substring(0, 200)}`, 'success');
  } catch (err) {
    showStatus(`测试失败: ${err.message}`, 'error');
  }
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
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function escapeHtml(text) {
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

// 事件绑定
document.getElementById('btn-add-account').addEventListener('click', addAccount);
document.getElementById('email-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addAccount();
});
document.getElementById('btn-save').addEventListener('click', saveSettings);
document.getElementById('btn-reset').addEventListener('click', resetSettings);

// 初始化
init();
