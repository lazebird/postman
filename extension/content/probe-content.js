/**
 * probe-content.js - 内容脚本（方案 C in-origin 探测）
 *
 * 为什么需要它：
 *   MV3 Service Worker 的跨源 fetch 属于「第三方上下文」，163/QQ 的登录 Cookie
 *   多数为 SameSite=Lax，不会被附带 → SW 永远拿不到登录态与 sid（前 4 轮失败根因）。
 *
 * 内容脚本注入到 mail.163.com / mail.qq.com 页面内运行：
 *   1. 与页面同源 → fetch 天然携带第一方登录 Cookie，无跨域/CORS 问题
 *   2. 可直接读取页面 DOM 中已渲染的真实未读数
 *   3. 可同源调用 webmail 内部接口（sid 可从页面环境或 iframe 获取）
 *
 * 本脚本通过 chrome.runtime.onMessage 接收 SW 的探测指令，
 * 在真实登录页面上执行探测并回传结果。
 */

(() => {
  // 避免重复注入
  if (window.__mailProbeContentLoaded__) return;
  window.__mailProbeContentLoaded__ = true;

  const HOST = location.host;

  /**
   * 提取页面 DOM 中的未读数
   * 163 / QQ 网页版收件箱左侧列表通常会渲染「收件箱(未读数)」或未读角标。
   * 同时回传可能暴露 sid 的信息（iframe src / window 变量）。
   */
  function extractUnreadFromDom() {
    const doc = document;
    const results = [];
    const allTexts = [];
    const candidates = [];

    // 1. 收集所有可见文本
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').trim();
      if (t) allTexts.push(t);
    }
    const joined = allTexts.join(' ');

    // 2. 匹配「收件箱(8)」「收件箱 (8)」等
    const folderRegex = /收件箱\s*[\(（]\s*(\d+)\s*[\)）]/g;
    let m;
    while ((m = folderRegex.exec(joined))) {
      candidates.push({ type: 'folder', value: parseInt(m[1], 10) });
    }

    // 3. 匹配侧栏常见未读字段（如 unread、badge）
    const badgeRegex = /["']?(?:unread|unreadCount|newMessageCount|count)["']?\s*[:=]\s*["']?(\d{1,4})["']?/gi;
    let bm;
    while ((bm = badgeRegex.exec(joined))) {
      candidates.push({ type: 'attr', value: parseInt(bm[1], 10) });
    }

    // 4. 查找含 sid 的 iframe 或链接（QQ 收件箱 frame src 常带 sid）
    let sid = null;
    doc.querySelectorAll('iframe[src], a[href]').forEach((el) => {
      const src = el.src || el.href || '';
      const sm = src.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/);
      if (sm && !sid) sid = sm[1];
    });

    // 5. 顶层 window 是否暴露 sid
    const winSid =
      (typeof window.sid !== 'undefined' && window.sid) ||
      (window.location.href.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/) || [])[1] ||
      null;

    // 合并去重：优先 folder 计数
    const folderCount = candidates.find(c => c.type === 'folder');
    const attrCounts = candidates.filter(c => c.type === 'attr').map(c => c.value);
    const maxAttr = attrCounts.length ? Math.max(...attrCounts) : null;

    results.push({
      url: location.href,
      folderCount: folderCount ? folderCount.value : null,
      attrCandidates: [...new Set(attrCounts)].slice(0, 20),
    });

    return {
      host: HOST,
      url: location.href,
      title: doc.title,
      folderCount: folderCount ? folderCount.value : null,
      attrCandidates: [...new Set(attrCounts)].slice(0, 20),
      sidFromDom: sid,
      sidFromUrl: winSid,
      bodyLength: (doc.body && doc.body.innerText ? doc.body.innerText.length : 0),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 在页面上下文内发同源 fetch（携带第一方 Cookie）
   * 通过 MAIN world 脚本调用页面自己的 fetch，规避 CSP 中扩展注入脚本的限制。
   */
  function probeInPageFetch(url, options) {
    return new Promise((resolve) => {
      const fnName = '__mailProbeFetch_' + Date.now();
      const script = document.createElement('script');
      script.textContent = `
        (function(){
          const __r = (window.__mailProbeResult) || [];
          window.${fnName} = null;
          fetch(${JSON.stringify(url)}, ${JSON.stringify(options || {})})
            .then(async (resp) => {
              let text = '';
              try { text = await resp.text(); } catch(e) {}
              const cb = window.${fnName};
              if (cb) cb({ ok: resp.ok, status: resp.status, text: text.substring(0, 4000) });
            })
            .catch((err) => {
              const cb = window.${fnName};
              if (cb) cb({ ok: false, error: String(err && err.message || err) });
            });
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      const timer = setTimeout(() => {
        delete window[fnName];
        resolve({ ok: false, error: 'in-page fetch timeout', url });
      }, 15000);

      window[fnName] = (result) => {
        clearTimeout(timer);
        delete window[fnName];
        resolve({ url, ...result });
      };
    });
  }

  /**
   * 计算「最可信」未读数
   */
  function computeBest(diag) {
    if (typeof diag.folderCount === 'number') {
      return { unread: diag.folderCount, source: 'folder-dom' };
    }
    if (diag.attrCandidates && diag.attrCandidates.length) {
      // 取中位数附近避免被其它数字干扰 —— 这里取最小值作为保守估计
      const vals = diag.attrCandidates.filter(v => v >= 0);
      if (vals.length) {
        return { unread: Math.min(...vals), source: 'attr-dom' };
      }
    }
    return { unread: null, source: 'none' };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.type !== 'probeContent163' && message.type !== 'probeContentQQ')) {
      return false;
    }

    (async () => {
      try {
        const diag = extractUnreadFromDom();
        const best = computeBest(diag);

        const detail = {
          provider: HOST.includes('qq.com') ? 'qq' : 'netease_163',
          host: HOST,
          documentReady: document.readyState,
          pageUrl: location.href,
          dom: diag,
          best,
        };

        sendResponse({
          success: true,
          loggedIn: !!best.unread || (diag.sidFromUrl || diag.sidFromDom) ? true : null,
          unreadCount: best.unread,
          unreadSource: best.source,
          detail,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // 异步
  });

  // 主动上报一次（页面加载完成后立即给 SW 一份基线数据）
  try {
    chrome.runtime.sendMessage({ type: 'contentPageReady', detail: {
      host: HOST,
      url: location.href,
      title: document.title,
      hasBody: !!(document.body && document.body.innerText),
    }}).catch(() => {});
  } catch (e) { /* SW 未就绪时忽略 */ }
})();
