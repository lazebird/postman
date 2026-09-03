/**
 * popup.js - Popup 逻辑
 *
 * 优化：
 * 1. 显示会话 sid 获取状态
 * 2. 添加"刷新会话"按钮
 * 3. 更清晰的探测结果显示
 * 4. 结果自动展开查看完整数据
 * 5. 输出栏增加快速复制按钮（含标题 + 数据）
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
    if (tabId === 'settings') refreshStatus();
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

// 方案C：内容脚本探测 163
const btnContent163 = document.getElementById('btn-content-163');
if (btnContent163) {
  btnContent163.addEventListener('click', async () => {
    const btn = btnContent163;
    btn.disabled = true; btn.textContent = '探测中...';
    try {
      const result = await sendMessage({ type: 'probeContent163', openTab: true });
      showProbeResult('获取未读数 · 163', result);
      await refreshStatus();
    } catch (err) {
      showProbeResult('探测失败', { success: false, error: err.message });
    } finally { btn.disabled = false; btn.textContent = '📥 获取未读数 · 163'; }
  });
}

// 方案C：内容脚本探测 QQ
const btnContentQQ = document.getElementById('btn-content-qq');
if (btnContentQQ) {
  btnContentQQ.addEventListener('click', async () => {
    const btn = btnContentQQ;
    btn.disabled = true; btn.textContent = '探测中...';
    try {
      const result = await sendMessage({ type: 'probeContentQQ', openTab: true });
      showProbeResult('获取未读数 · QQ', result);
      await refreshStatus();
    } catch (err) {
      showProbeResult('探测失败', { success: false, error: err.message });
    } finally { btn.disabled = false; btn.textContent = '📥 获取未读数 · QQ'; }
  });
}

// Cookie 会话诊断
const btnDiagCookies = document.getElementById('btn-diagnose-cookies');
if (btnDiagCookies) {
  btnDiagCookies.addEventListener('click', async () => {
    const btn = btnDiagCookies;
    btn.disabled = true; btn.textContent = '诊断中...';
    try {
      const result = await sendMessage({ type: 'diagnoseCookies' });
      showProbeResult('🍪 会话 Cookie 诊断', result);
    } catch (err) {
      showProbeResult('诊断失败', { success: false, error: err.message });
    } finally { btn.disabled = false; btn.textContent = '🍪 诊断会话 Cookie'; }
  });
}

// 检查认证状态
document.getElementById('btn-check-bridge').addEventListener('click', async () => {
  const btn = document.getElementById('btn-check-bridge');
  btn.disabled = true;
  btn.textContent = '检查中...';

  try {
    const [result163, resultQQ] = await Promise.all([
      sendMessage({ type: 'checkBridge', provider: 'netease_163' }),
      sendMessage({ type: 'checkBridge', provider: 'qq' })
    ]);
    showProbeResult('认证状态检查', {
      '163邮箱': formatAuthResult(result163),
      'QQ邮箱': formatAuthResult(resultQQ),
    });
  } catch (err) {
    showProbeResult('认证检查失败', { success: false, error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '检查认证';
  }
});

// 刷新会话 sid
const btnRefreshSession = document.getElementById('btn-refresh-session');
if (btnRefreshSession) {
  btnRefreshSession.addEventListener('click', async () => {
    const btn = btnRefreshSession;
    btn.disabled = true;
    btn.textContent = '刷新中...';

    try {
      const results = {};
      for (const provider of ['netease_163', 'qq']) {
        const r = await sendMessage({ type: 'refreshSession', provider });
        results[provider === 'netease_163' ? '163邮箱' : 'QQ邮箱'] = {
          loggedIn: r.loggedIn,
          needsAuth: r.needsAuth,
          hasSid: r.hasSid,
          sid: r.sid || null,
          contentUnread: r.contentProbe?.probe?.unreadCount ?? null,
        };
      }
      showProbeResult('会话刷新结果', results);
    } catch (err) {
      showProbeResult('会话刷新失败', { success: false, error: err.message });
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 刷新会话';
    }
  });
}

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

function formatAuthResult(result) {
  if (!result) return { error: 'No result' };
  return {
    authState: result.authState || 'needs_auth',
    loggedIn: result.loggedIn,
    needsAuth: result.needsAuth,
    detail: result.detail || {},
  };
}

async function refreshStatus() {
  const status = await sendMessage({ type: 'getStatus' });

  // 渲染状态
  const overview = document.getElementById('settings-overview');
  overview.innerHTML = '';

  // 计算所有账户未读总和（用于展示在状态概览）
  let totalUnreadAll = 0;
  let hasAnyUnread = false;
  (status.accountStatus || []).forEach(as => {
    if (typeof as.unreadCount === 'number') {
      totalUnreadAll += as.unreadCount;
      if (as.unreadCount > 0) hasAnyUnread = true;
    }
  });

  const items = [
    ['账户数量', String(status.accountCount || 0)],
    ['全部未读', hasAnyUnread ? `<b style="color:#dc3545;">${totalUnreadAll} 封</b>` : '0 封'],
    ['检查间隔', `${status.settings?.checkIntervalMinutes || 5} 分钟`],
    ['检查模式', providerMode(status.settings?.checkMode || 'hybrid')],
    ['163 sid', status.cachedSids?.netease_163 ? '✅ 已缓存' : '❌ 未同步'],
    ['QQ sid', status.cachedSids?.qq ? '✅ 已缓存' : '❌ 未同步'],
    ['163 API 模式', `${status.apiPatternCounts?.netease_163 || 0} 条已学习`],
    ['QQ API 模式', `${status.apiPatternCounts?.qq || 0} 条已学习`],
    ['闹钟', status.alarmConfigured ? `✅ ${status.alarmInfo?.periodInMinutes || '?'}分钟/次` : '❌ 未配置'],
  ];

  items.forEach(([label, value]) => {
    const div = document.createElement('div');
    div.className = 'status-item';
    div.innerHTML = `<span class="label">${label}</span><span class="value">${escapeHtml(value)}</span>`;
    overview.appendChild(div);
  });

  // 渲染账户列表（按账户显示状态 + 未读数 + 快速跳转链接）
  const accountsList = document.getElementById('accounts-list');
  if (!status.accounts?.length) {
    accountsList.innerHTML = '<div class="empty">未配置任何邮箱账户，请前往设置添加</div>';
  } else {
    accountsList.innerHTML = '';
    // 从 getStatus 获取聚合好的 accountStatus（含 unreadCount/auth 状态）
    const accStatusMap = {};
    (status.accountStatus || []).forEach(as => {
      accStatusMap[as.email] = as;
    });

    status.accounts.forEach(acc => {
      const st = accStatusMap[acc.email] || {};
      const card = document.createElement('div');
      card.className = 'account-card';

      // 未读数
      const unread = (typeof st.unreadCount === 'number') ? st.unreadCount : null;
      const unreadHtml = unread !== null
        ? `<span class="acc-unread ${unread > 0 ? 'acc-unread-num' : 'acc-unread-zero'}">${unread}</span>`
        : '<span class="acc-unread acc-unread-zero" style="font-size:13px;">-</span>';

      // 状态徽标
      let statusBadge = '';
      if (st.needsInboxPage === true) {
        statusBadge = '<span class="acc-status-badge acc-status-need">⚠️ 打开收件箱</span>';
      } else if (st.authVerified === true) {
        statusBadge = '<span class="acc-status-badge acc-status-auth">✅ 已授权</span>';
      } else if (st.needsAuth === true) {
        statusBadge = '<span class="acc-status-badge acc-status-need">⚠️ 需授权</span>';
      } else if (st.hasSid === true) {
        statusBadge = '<span class="acc-status-badge acc-status-auth">✅ sid已缓存</span>';
      } else {
        statusBadge = '<span class="acc-status-badge acc-status-err">未检查</span>';
      }

      // 跳转链接
      const jumpBtn = `<button class="acc-action-btn jump" data-email="${escapeHtml(acc.email)}" data-provider="${acc.provider}" title="跳转到未读邮件">📥</button>`;
      const refreshBtn = `<button class="acc-action-btn" data-email="${escapeHtml(acc.email)}" data-provider="${acc.provider}" data-action="refresh" title="检查该账户">🔄</button>`;

      card.innerHTML = `
        <div class="acc-info">
          <div class="acc-email">${escapeHtml(acc.email)} ${statusBadge}</div>
          <div class="acc-meta">${providerName(acc.provider)}${st.timestamp ? ` · 最近 ${new Date(st.timestamp).toLocaleTimeString()}` : ''}${st.method ? ` · ${st.method}` : ''}</div>
        </div>
        <div style="display:flex;align-items:center;">
          ${unreadHtml}
          <div class="acc-actions">${refreshBtn}${jumpBtn}</div>
        </div>
      `;
      accountsList.appendChild(card);
    });

    // 绑定跳转和刷新事件
    accountsList.querySelectorAll('.acc-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.provider;
        const action = btn.dataset.action || 'jump';
        if (action === 'jump') {
          try {
            await sendMessage({ type: 'openInbox', provider });
          } catch (err) {
            console.error('打开邮箱失败:', err);
          }
        } else if (action === 'refresh') {
          btn.disabled = true;
          btn.textContent = '…';
          try {
            const r = await sendMessage({ type: 'testProvider', provider });
            // testProvider 走 checkSingleAccount 流程，会 saveCheckResult → 展示用
            await refreshStatus();
          } catch (err) {
            console.error('刷新失败:', err);
          }
        }
      });
    });
  }
}

function providerMode(mode) {
  const modes = { 'hybrid': '混合', 'content-script': '内容脚本', 'sw-api': 'SW API' };
  return modes[mode] || mode;
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
  const titleEl = document.getElementById('probe-result-title');
  const copyBtn = document.getElementById('btn-copy-result');

  container.style.display = 'block';
  text.textContent = JSON.stringify(data, null, 2);

  // 设置标题
  if (titleEl) titleEl.textContent = `【${title}】`;

  // 重置复制按钮状态
  if (copyBtn) {
    copyBtn.textContent = '📋 复制';
    copyBtn.classList.remove('copied');
  }
}

// 快速复制输出内容
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
      btnCopyResult.textContent = '✅ 已复制';
      btnCopyResult.classList.add('copied');
      setTimeout(() => {
        btnCopyResult.textContent = '📋 复制';
        btnCopyResult.classList.remove('copied');
      }, 2000);
    } catch (err) {
      // clipboard API 不可用时回退到 execCommand
      try {
        // Fallback: temporarily set the combined text to select & copy
        const originalText = textEl.textContent;
        const titleEl2 = document.getElementById('probe-result-title');
        const fullText = titleEl2.textContent
          ? `${titleEl2.textContent}\n${originalText}`
          : originalText;
        textEl.textContent = fullText;
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand('copy');
        textEl.textContent = originalText;
        sel.removeAllRanges();
        if (ok) {
          btnCopyResult.textContent = '✅ 已复制';
          btnCopyResult.classList.add('copied');
          setTimeout(() => {
            btnCopyResult.textContent = '📋 复制';
            btnCopyResult.classList.remove('copied');
          }, 2000);
        } else {
          btnCopyResult.textContent = '❌ 复制失败';
        }
      } catch (e2) {
        btnCopyResult.textContent = '❌ 复制失败';
      }
    }
  });
}

async function refreshLogs() {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    const container = document.getElementById('logs-container');

    if (!debugLogs.length) {
      container.innerHTML = '<div class="empty">暂无日志</div>';
      return;
    }

    container.innerHTML = debugLogs.slice(0, 80).map(log => {
      const cls = log.level.toLowerCase();
      const detail = log.detail ? `<br><small>${escapeHtml(log.detail)}</small>` : '';
      return `<div class="${cls}">[${new Date(log.ts).toLocaleTimeString()}] [${log.level}] [${escapeHtml(log.module)}] ${escapeHtml(log.message)}${detail}</div>`;
    }).join('');
  } catch (err) {
    document.getElementById('logs-container').innerHTML = `<div class="error">读取日志失败: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
});
