/**
 * popup.js - Popup 逻辑
 */

// Tab 切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));

    tab.classList.add('active');
    const tabId = tab.dataset.tab;
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'logs') refreshLogs();
  });
});

// 打开设置
document.getElementById('link-options').addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

// 全量检查按钮
document.getElementById('btn-full-check').addEventListener('click', async () => {
  const btn = document.getElementById('btn-full-check');
  btn.disabled = true;
  btn.textContent = '⏳ 检查中...';

  try {
    const result = await sendMessage({ type: 'runCheck' });
    showProbeResult('全量检查结果', result);
    await refreshStatus();
  } catch (err) {
    showProbeResult('全量检查失败', { success: false, error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 运行全量检查';
  }
});

// 探测 163
document.getElementById('btn-probe-163').addEventListener('click', async () => {
  const btn = document.getElementById('btn-probe-163');
  btn.disabled = true;
  btn.textContent = '探测中...';

  try {
    const result = await sendMessage({ type: 'testProvider', provider: 'netease_163' });
    showProbeResult('163 探测结果', result);
    await refreshStatus();
  } catch (err) {
    showProbeResult('163 探测失败', { success: false, error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '探测 163';
  }
});

// 探测 QQ
document.getElementById('btn-probe-qq').addEventListener('click', async () => {
  const btn = document.getElementById('btn-probe-qq');
  btn.disabled = true;
  btn.textContent = '探测中...';

  try {
    const result = await sendMessage({ type: 'testProvider', provider: 'qq' });
    showProbeResult('QQ 探测结果', result);
    await refreshStatus();
  } catch (err) {
    showProbeResult('QQ 探测失败', { success: false, error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '探测 QQ';
  }
});

// 检查认证状态
document.getElementById('btn-check-bridge').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-bridge');
  btn.disabled = true;
  btn.textContent = '检查中...';

  try {
    // 检查两个主要提供商的认证状态
    const [result163, resultQQ] = await Promise.all([
      sendMessage({ type: 'checkBridge', provider: 'netease_163' }),
      sendMessage({ type: 'checkBridge', provider: 'qq' })
    ]);
    showProbeResult('认证状态检查', {
      '163邮箱': result163,
      'QQ邮箱': resultQQ,
    });
  } catch (err) {
    showProbeResult('认证检查失败', { success: false, error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '检查认证';
  }
});

// 刷新日志
document.getElementById('btn-refresh-logs').addEventListener('click', () => {
  refreshLogs();
});

// ===== 辅助函数 =====

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

async function refreshStatus() {
  const status = await sendMessage({ type: 'getStatus' });

  // 渲染状态
  const overview = document.getElementById('status-overview');
  overview.innerHTML = '';

  const items = [
    ['账户数量', String(status.accountCount)],
    ['检查间隔', `${status.settings?.checkIntervalMinutes || 5} 分钟`],
    ['闹钟', status.alarmConfigured ? `✅ ${status.alarmInfo?.periodInMinutes}分钟/次` : '❌ 未配置'],
    ['本地桥接', status.nativeMessagingAvailable ? '✅ 可用' : '未安装（方案B不需要）'],
  ];

  items.forEach(([label, value]) => {
    const div = document.createElement('div');
    div.className = 'status-item';
    div.innerHTML = `<span class="label">${label}</span><span class="value">${escapeHtml(value)}</span>`;
    overview.appendChild(div);
  });

  // 渲染最近结果
  if (status.recentResults?.length) {
    const latest = status.recentResults[0];
    const resultDiv = document.createElement('div');
    resultDiv.className = 'status-item';
    const time = new Date(latest.timestamp || Date.now()).toLocaleTimeString();
    const badge = latest.success
      ? '<span class="provider-status status-ok">成功</span>'
      : '<span class="provider-status status-fail">失败</span>';
    resultDiv.innerHTML = `<span class="label">最近检查 (${time})</span>${badge}`;
    overview.appendChild(resultDiv);
  }

  // 渲染账户列表
  const accountsList = document.getElementById('accounts-list');
  if (!status.accounts?.length) {
    accountsList.innerHTML = '<div class="empty">未配置任何邮箱账户，请前往设置添加</div>';
  } else {
    accountsList.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'provider-list';
    status.accounts.forEach(acc => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="provider-name">${escapeHtml(acc.email)}</span>
        <span class="badge ${acc.provider === 'qq' ? 'badge-orange' : 'badge-blue'}">${providerName(acc.provider)}</span>
      `;
      ul.appendChild(li);
    });
    accountsList.appendChild(ul);
  }
}

function providerName(provider) {
  const names = {
    'netease_163': '163邮箱',
    'qq': 'QQ邮箱',
    'ustc': 'USTC',
    'gmail': 'Gmail',
  };
  return names[provider] || provider;
}

function showProbeResult(title, data) {
  const container = document.getElementById('probe-result');
  const text = document.getElementById('probe-result-text');
  container.style.display = 'block';
  text.textContent = `【${title}】\n${JSON.stringify(data, null, 2)}`;
}

async function refreshLogs() {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    const container = document.getElementById('logs-container');

    if (!debugLogs.length) {
      container.innerHTML = '<div class="empty">暂无日志</div>';
      return;
    }

    container.innerHTML = debugLogs.slice(0, 50).map(log => {
      const cls = log.level.toLowerCase();
      const detail = log.detail ? `<br><small>${escapeHtml(log.detail)}</small>` : '';
      return `<div class="${cls}">[${new Date(log.ts).toLocaleTimeString()}] [${log.level}] [${log.module}] ${escapeHtml(log.message)}${detail}</div>`;
    }).join('');
  } catch (err) {
    document.getElementById('logs-container').innerHTML = `<div class="error">读取日志失败: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
});
