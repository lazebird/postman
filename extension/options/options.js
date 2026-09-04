/**
 * options.js - 设置页逻辑
 *
 * 混合方案：
 *   1. 添加检查模式选择（hybrid/content-script/sw-api）
 *   2. 添加「同步会话」按钮（打开邮箱页 → 提取 sid → 缓存供 SW 使用）
 *   3. 会话状态卡片展示缓存 sid 状态
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
    { name: 'js6_rpc_list', label: 'js6/s RPC - mbox:listMessages 收件箱列表' },
    { name: 'js6_rpc_getfolder', label: 'js6/s RPC - mbox:getFolderCount 文件夹计数' },
    { name: 'js6_rpc_getunread', label: 'js6/s RPC - mbox:getUnread 未读计数' },
    { name: 'js6_sys_getfolder', label: 'js6/s - global:getSessionInfo 会话信息' },
  ],
  qq: [
    { name: 'wx_readdata', label: 'wx.mail.qq.com - readdata 读取收件箱' },
    { name: 'wx_readindex', label: 'wx.mail.qq.com - readindex 读取邮箱索引' },
    { name: 'wx_mail_list', label: 'wx.mail.qq.com - mail_list 收件箱列表' },
    { name: 'wx_unread', label: 'wx.mail.qq.com - unread 未读计数' },
    { name: 'cgi_mail_list', label: 'mail.qq.com - cgi-bin/mail_list 收件箱列表' },
    { name: 'cgi_fr_show', label: 'mail.qq.com - cgi-bin/fr_show 轻量未读' },
  ],
};

let currentAccounts = [];
let currentSettings = {};

async function init() {
  try {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    currentAccounts = Array.isArray(accounts) ? accounts : [];

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
    list.innerHTML =
      '<div class="help-text">暂无账户，请先在下方添加。添加邮箱账户后，需先在浏览器中打开并登录对应邮箱网页。</div>';
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
  const modeSelect = document.getElementById('mode-select');

  if (currentSettings.checkIntervalMinutes) {
    intervalSelect.value = String(currentSettings.checkIntervalMinutes);
  }
  if (currentSettings.logLevel) {
    logLevelSelect.value = currentSettings.logLevel;
  }
  if (currentSettings.checkMode) {
    modeSelect.value = currentSettings.checkMode;
  }
}

function renderEndpoints() {
  const container = document.getElementById('endpoint-config');

  const providers = Object.keys(ENDPOINT_OPTIONS);
  const sections = providers
    .map((provider) => {
      const endpoints = ENDPOINT_OPTIONS[provider];
      const enabled = currentSettings.enabledEndpoints?.[provider] || [];

      const checks = endpoints
        .map((ep) => {
          const checked = enabled.includes(ep.name) ? 'checked' : '';
          return `
        <div class="endpoint-checkbox">
          <input type="checkbox" id="ep-${provider}-${ep.name}" data-provider="${provider}" data-endpoint="${ep.name}" ${checked}>
          <label for="ep-${provider}-${ep.name}">${escapeHtml(ep.label)}</label>
        </div>
      `;
        })
        .join('');

      return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:600;font-size:14px;margin-bottom:6px;">${PROVIDER_LABELS[provider] || provider}</div>
        ${checks}
      </div>
    `;
    })
    .join('');

  container.innerHTML = sections;
}

/**
 * 渲染会话状态：展示缓存 sid 情况和内容脚本状态
 */
async function renderSessionStatus() {
  const container = document.getElementById('session-status');
  if (!container) return;

  container.innerHTML = '<div class="help-text">正在检查会话状态...</div>';

  try {
    // 获取 SW 状态（含缓存 sid 信息）
    const status = await sendSWMessage({ type: 'getStatus' }).catch(() => null);

    if (status) {
      const sid163 = status.cachedSids?.netease_163;
      const sidQQ = status.cachedSids?.qq;

      const sid163Badge = sid163
        ? '<span class="sid-chip sid-ok">已授权 ✅</span>'
        : '<span class="sid-chip sid-no">未授权 ❌</span>';
      const sidQQBadge = sidQQ
        ? '<span class="sid-chip sid-ok">已授权 ✅</span>'
        : '<span class="sid-chip sid-no">未授权 ❌</span>';

      // 获取最近一次单账户结果，展示授权/获取的清晰状态
      const sample =
        status.recentResults?.find(
          (r) => r.unreadCount != null || r.authVerified === true || r.needsInboxPage === true
        ) || status.recentResults?.[0];
      let recentInfo = '';
      if (sample) {
        const time = new Date(sample.timestamp || Date.now()).toLocaleTimeString();
        const unread = sample.unreadCount;
        const method = sample.method || 'none';
        const needAuth = sample.needsAuth === true;
        const needInbox = sample.needsInboxPage === true;
        let statusTxt = '❌ 未授权';
        if (sample.authVerified === true) statusTxt = '✅ 已授权';
        if (typeof unread === 'number') statusTxt = `✅ 已授权 · 未读 ${unread} 封`;
        else if (needInbox) statusTxt = '⚠️ 已授权但需打开收件箱主页面';
        recentInfo = `<div class="hint" style="font-size:12px;color:#6c757d;margin-top:6px;">
          最近检查 (${time}): ${statusTxt}${typeof unread === 'number' ? '' : ''} (方法: ${method})${needAuth ? ' — 请点击下方「同步会话」授权' : ''}${needInbox ? ' — 请在邮箱中打开「收件箱」再点「内容脚本探测」' : ''}
        </div>`;
      }

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
          <div style="flex:1;">
            <strong>163邮箱</strong>
            ${sid163Badge}
          </div>
          <div style="flex:1;text-align:right;">
            <strong>QQ邮箱</strong>
            ${sidQQBadge}
          </div>
        </div>
        <div class="hint" style="font-size:12px;color:#6c757d;margin-top:4px;">
          <b>授权</b>：点下方「同步163/QQ会话」→ 扩展打开邮箱页 → 自动提取会话令牌 sid。<br>
          <b>获取未读数</b>：授权后在邮箱中停留在「收件箱」主页面，再点「内容脚本探测」即可读到未读数。<br>
          缓存 sid 约 30 分钟有效，过期后需重新同步授权。
        </div>
        ${recentInfo}
      `;
    } else {
      container.innerHTML =
        '<div class="help-text">无法获取状态。请检查 Service Worker 是否正常运行。</div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="help-text">会话状态检查失败: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * 同步会话：打开邮箱页 → 内容脚本提取 sid → 缓存
 */
async function syncSession(provider) {
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  const pre = document.getElementById('plan-c-result');
  if (pre) {
    pre.style.display = 'block';
    pre.textContent = `正在同步 ${providerLabel} 会话...`;
  }

  try {
    // 请求 SW 打开邮箱页并等待内容脚本提取 sid
    const msgType = provider === 'qq' ? 'probeContentQQ' : 'probeContent163';
    const r = await sendSWMessage({ type: msgType, openTab: true });

    if (r?.probe?.success) {
      const sid = r.probe.sid;
      const unread = r.probe.unreadCount;
      const pageType = r.probe.pageType || null;
      const needsInbox = r.probe.needsInboxPage === true || r.probe.authVerified === true;
      if (pre) {
        pre.textContent = JSON.stringify(
          {
            success: true,
            authVerified: !!sid,
            sidObtained: !!sid,
            sid: sid ? sid.substring(0, 8) + '...' : null,
            unreadCount: unread ?? null,
            pageType,
            detail: r.probe.detail,
          },
          null,
          2
        );
      }
      if (sid) {
        // 已授权
        if (typeof unread === 'number') {
          showStatus(`${providerLabel} 授权成功 ✅，未读 ${unread} 封`, 'success');
        } else if (needsInbox || pageType !== 'inbox') {
          showStatus(
            `${providerLabel} 已授权 ✅，但当前在辅助页面，请在邮箱中打开「收件箱」后再读取未读数`,
            'success'
          );
        } else {
          showStatus(`${providerLabel} 授权成功 ✅`, 'success');
        }
      } else {
        showStatus(
          `${providerLabel} 未检测到登录会话。请先在浏览器打开并登录 ${providerLabel}，再点「同步会话」`,
          'error'
        );
      }
    } else {
      if (pre) pre.textContent = JSON.stringify(r, null, 2);
      showStatus(
        `${providerLabel} 同步失败: ${r?.probe?.error || '请确认已在浏览器登录 ' + providerLabel + ' 并打开邮箱页'}`,
        'error'
      );
    }
    await renderSessionStatus();
  } catch (err) {
    if (pre) pre.textContent = '错误: ' + err.message;
    showStatus(`${providerLabel} 同步失败: ${err.message}`, 'error');
    await renderSessionStatus();
  }
}

/**
 * 内容脚本直接探测
 */
async function runPlanC(provider) {
  const pre = document.getElementById('plan-c-result');
  if (pre) {
    pre.style.display = 'block';
    pre.textContent = '探测中...';
  }

  const msgType = provider === 'qq' ? 'probeContentQQ' : 'probeContent163';
  try {
    const r = await sendSWMessage({ type: msgType, openTab: true });
    if (pre) pre.textContent = JSON.stringify(r, null, 2);
    showStatus(
      `内容脚本探测完成 (${PROVIDER_LABELS[provider]})`,
      r?.probe?.success ? 'success' : 'error'
    );
    await renderSessionStatus();
  } catch (err) {
    if (pre) pre.textContent = '错误: ' + err.message;
    showStatus(`内容脚本探测失败: ${err.message}`, 'error');
  }
}

/**
 * Cookie 会话诊断
 */
async function runCookieDiag() {
  const pre = document.getElementById('plan-c-result');
  if (pre) {
    pre.style.display = 'block';
    pre.textContent = '诊断中...';
  }
  try {
    const r = await sendSWMessage({ type: 'diagnoseCookies' });
    if (pre) pre.textContent = JSON.stringify(r, null, 2);
    showStatus('会话 Cookie 诊断完成', 'success');
  } catch (err) {
    if (pre) pre.textContent = '错误: ' + err.message;
    showStatus(`Cookie 诊断失败: ${err.message}`, 'error');
  }
}

async function addAccount() {
  const provider = document.getElementById('provider-select').value;
  const email = document.getElementById('email-input').value.trim();

  if (!email) {
    alert('请输入邮箱地址');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert('邮箱格式不正确');
    return;
  }

  if (currentAccounts.some((a) => a.email === email && a.provider === provider)) {
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
    // SW 可能不在线
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
    const authVerified = result?.results?.[0]?.authVerified;
    const unreadCount = findUnreadFromResult(result);
    const msg = authVerified
      ? `${providerLabel} 检查成功${unreadCount !== null ? `，未读: ${unreadCount}` : ''}`
      : `${providerLabel} 未能获取未读数，可能需要同步会话`;

    showStatus(msg, authVerified ? 'success' : 'error');
  } catch (err) {
    showStatus(`测试失败: ${err.message}`, 'error');
  }
}

function findUnreadFromResult(result) {
  try {
    const accountResult = result?.results?.[0];
    if (!accountResult) return null;
    if (typeof accountResult.unreadCount === 'number') {
      return accountResult.unreadCount;
    }
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
  const checkMode = document.getElementById('mode-select').value;

  // 收集接口启用状态
  const enabledEndpoints = {};
  document.querySelectorAll('input[type="checkbox"][data-provider]').forEach((cb) => {
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
    checkMode,
    enabledEndpoints,
  };

  await chrome.storage.local.set({ settings: currentSettings });

  try {
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
  } catch (e) {}

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
  setTimeout(() => {
    el.style.display = 'none';
  }, 4000);
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// 暴露全局函数
window.addAccount = addAccount;
window.removeAccount = removeAccount;
window.testAccount = testAccount;
window.saveSettings = saveSettings;
window.resetSettings = resetSettings;
window.syncSession = syncSession;

// 事件绑定
document.addEventListener('DOMContentLoaded', () => {
  const btnAdd = document.getElementById('btn-add-account');
  const emailInput = document.getElementById('email-input');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');
  const btnContent163 = document.getElementById('btn-content-163');
  const btnContentQQ = document.getElementById('btn-content-qq');
  const btnDiagCookies = document.getElementById('btn-diagnose-cookies');
  const btnSync163 = document.getElementById('btn-sync-163');
  const btnSyncQQ = document.getElementById('btn-sync-qq');

  if (btnSync163) btnSync163.addEventListener('click', () => syncSession('netease_163'));
  if (btnSyncQQ) btnSyncQQ.addEventListener('click', () => syncSession('qq'));
  if (btnContent163) btnContent163.addEventListener('click', () => runPlanC('netease_163'));
  if (btnContentQQ) btnContentQQ.addEventListener('click', () => runPlanC('qq'));
  if (btnDiagCookies) btnDiagCookies.addEventListener('click', runCookieDiag);

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
