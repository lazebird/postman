/**
 * probe-content.js - 内容脚本（方案 C in-origin 探测）
 *
 * 混合方案核心：
 *   1. 内容脚本在邮箱页面（同源上下文）中运行，读取真实未读数
 *   2. 同时从页面 URL / DOM 提取 sid 会话令牌
 *   3. 将 sid 回传给 SW → SW 缓存 sid 后可独立调 API 进行后台检查
 *
 * v0.8.0 新增：
 *   - API 请求捕获：注入 main world 脚本拦截页面 fetch/XHR 请求，
 *     将真实 API 调用（URL/method/headers/body）发送给 SW 存储，
 *     供后台无页面时精确复现请求。
 */

(() => {
  // 避免重复注入
  if (window.__mailProbeContentLoaded__) return;
  window.__mailProbeContentLoaded__ = true;

  const HOST = location.host;
  const isQQ = HOST.includes('qq.com');
  const is163 = HOST.includes('163.com');
  // 判断当前 frame 是否为主（顶层）frame。
  let isTopFrame = false;
  try { isTopFrame = window === window.top; } catch (e) { isTopFrame = false; }

  // ============================================================
  // API 请求拦截器（main world 注入）
  // ============================================================
  // 在页面主世界注入脚本，拦截 fetch 与 XHR 请求，
  // 记录 URL/method/body 等信息后回传给内容脚本。
  const API_INTERCEPTOR_SCRIPT = `
    (function() {
      if (window.__mailApiInterceptorInstalled__) return;
      window.__mailApiInterceptorInstalled__ = true;

      // 避免发送过多数据
      const MAX_BODY_LEN = 2000;
      const MAX_PATTERNS = 30;
      const recentUrls = new Set();

      function reportCapture(capture) {
        try {
          window.postMessage({ source: '__mailApiCapture__', capture }, '*');
        } catch(e) {}
      }

      // ---- 拦截 fetch ----
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function(...args) {
          try {
            let url = '';
            let method = 'GET';
            let body = null;
            let headers = {};

            if (typeof args[0] === 'string') url = args[0];
            else if (args[0] && args[0].url) url = args[0].url;

            const opts = args[1] || {};
            if (opts.method) method = opts.method;
            if (opts.body) {
              body = typeof opts.body === 'string' ? opts.body.substring(0, MAX_BODY_LEN) : null;
            }
            if (opts.headers) {
              try {
                if (opts.headers instanceof Headers) {
                  opts.headers.forEach((v, k) => { headers[k] = v; });
                } else if (typeof opts.headers === 'object') {
                  headers = { ...opts.headers };
                }
              } catch(e) {}
            }

            // 检查 URL 是否与未读/邮箱相关，避免记录无关请求
            const isRelevant = /(js6\/s|mbox|mail_list|readdata|readindex|unread|folder|getfolder|getSession|fr_show|mail\.163\.com|mail\.qq\.com|wx\.mail\.qq\.com)/i.test(url);
            if (isRelevant && !recentUrls.has(method + url + (body||''))) {
              recentUrls.add(method + url + (body||''));
              if (recentUrls.size > MAX_PATTERNS) {
                const firstKey = recentUrls.values().next().value;
                recentUrls.delete(firstKey);
              }
              // 移除 cookie header（由 fetch credentials 自动处理）
              delete headers['cookie'];
              delete headers['Cookie'];
              reportCapture({
                type: 'fetch',
                url,
                method,
                body: body ? body.substring(0, MAX_BODY_LEN) : null,
                headers,
                timestamp: Date.now()
              });
            }
          } catch(e) {}
          return origFetch.apply(this, args);
        };
      }

      // ---- 拦截 XHR ----
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__mailApiUrl = url;
        this.__mailApiMethod = method || 'GET';
        return origOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function(body, ...rest) {
        try {
          const url = String(this.__mailApiUrl || '');
          const method = String(this.__mailApiMethod || 'GET');
          const isRelevant = /(js6\/s|mbox|mail_list|readdata|readindex|unread|folder|getfolder|getSession|fr_show|mail\.163\.com|mail\.qq\.com|wx\.mail\.qq\.com)/i.test(url);
          if (isRelevant && !recentUrls.has(method + url)) {
            recentUrls.add(method + url);
            if (recentUrls.size > MAX_PATTERNS) {
              const firstKey = recentUrls.values().next().value;
              recentUrls.delete(firstKey);
            }
            const bodyStr = body ? String(body).substring(0, MAX_BODY_LEN) : null;
            reportCapture({
              type: 'xhr',
              url,
              method,
              body: bodyStr,
              timestamp: Date.now()
            });
          }
        } catch(e) {}
        return origSend.call(this, body, ...rest);
      };
    })();
  `;

  // 在所有 frame 中注入拦截器（收集不同 iframe 的 API 调用）
  try {
    const s = document.createElement('script');
    s.textContent = API_INTERCEPTOR_SCRIPT;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch(e) {
    // 注入失败不阻塞主功能
  }

  // 接收页面 main world 发送的 API 捕获数据
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== '__mailApiCapture__') return;
    const capture = event.data.capture;
    if (!capture || !capture.url) return;

    // 发送给 SW 存储（只从顶层 frame 上报）
    if (isTopFrame) {
      try {
        // 从页面 URL 提取当前 sid，供 SW 正确替换捕获模式中的 sid
        const urlSid = (location.href.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/) || [])[1] || null;
        chrome.runtime.sendMessage({
          type: 'apiCapture',
          provider: isQQ ? 'qq' : is163 ? 'netease_163' : null,
          capture: {
            ...capture,
            currentSid: urlSid || undefined,
          }
        }).catch(() => {});
      } catch(e) {}
    }
  });

  /**
   * 提取页面 DOM 中的未读数
   */
  function extractUnreadFromDom() {
    const doc = document;
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

    // 2. 匹配「收件箱(8)」「收件箱 (8)」等（163 用括号包裹）
    const folderRegex = /收件箱\s*[\(（]\s*(\d+)\s*[\)）]/g;
    let m;
    while ((m = folderRegex.exec(joined))) {
      candidates.push({ type: 'folder', value: parseInt(m[1], 10) });
    }

    // 2b. QQ 邮箱特有结构
    const qqFolderPatterns = [
      /收件箱\s*[\(（\[\[]\s*(\d{1,4})\s*[\)）\]\]]/g,
      /收件箱\s*(?:\|)?\s*[【\[]?\s*(\d{1,4})\s*[】\]]?\s*(?:未读|封)?/g,
    ];
    for (const re of qqFolderPatterns) {
      re.lastIndex = 0;
      let qm;
      while ((qm = re.exec(joined)) !== null) {
        const val = parseInt(qm[1], 10);
        if (val > 0) candidates.push({ type: 'folder', value: val });
        re.lastIndex = qm.index + 1;
      }
    }

    // 3. 匹配侧栏常见未读字段
    const badgeRegex = /["']?(?:unread|unreadCount|newMessageCount|count)["']?\s*[:=]\s*["']?(\d{1,4})["']?/gi;
    let bm;
    while ((bm = badgeRegex.exec(joined))) {
      candidates.push({ type: 'attr', value: parseInt(bm[1], 10) });
    }

    // 3b. class/data 属性中的未读数
    doc.querySelectorAll('[class*="unread"],[class*="new"],[class*="count"],[class*="badge"],[data-unread]').forEach((el) => {
      const own = el.textContent ? el.textContent.trim() : '';
      if (/^\d{1,4}$/.test(own)) candidates.push({ type: 'attr', value: parseInt(own, 10) });
      const dataUnread = el.getAttribute && el.getAttribute('data-unread');
      if (dataUnread && /^\d{1,4}$/.test(dataUnread.trim())) {
        candidates.push({ type: 'attr', value: parseInt(dataUnread.trim(), 10) });
      }
    });

    // 4. 查找含 sid 的 iframe 或链接
    let sid = null;
    doc.querySelectorAll('iframe[src], a[href]').forEach((el) => {
      const src = el.src || el.href || '';
      const sm = src.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/);
      if (sm && !sid) sid = sm[1];
    });

    // 5. 顶层 window / location.href 提取 sid
    const winSid =
      (typeof window.sid !== 'undefined' && window.sid) ||
      (window.location.href.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/) || [])[1] ||
      null;

    // 6. 提取页面标题中的未读数
    let titleUnread = null;
    const titleMatch = doc.title.match(/[\(（]\s*(\d+)\s*封?未读\s*[\)）]/);
    if (titleMatch) titleUnread = parseInt(titleMatch[1], 10);

    // 合并去重
    const folderCount = candidates.find(c => c.type === 'folder');
    const attrCounts = candidates.filter(c => c.type === 'attr').map(c => c.value);

    const allValues = [];
    if (folderCount) allValues.push(folderCount.value);
    if (titleUnread !== null) allValues.push(titleUnread);
    allValues.push(...attrCounts);
    const uniqueValues = [...new Set(allValues)].slice(0, 20);

    return {
      host: HOST,
      url: location.href,
      title: doc.title,
      titleUnread,
      folderCount: folderCount ? folderCount.value : null,
      attrCandidates: [...new Set(attrCounts)].slice(0, 20),
      allCandidateValues: uniqueValues,
      sidFromDom: sid,
      sidFromUrl: winSid,
      bodyLength: (doc.body && doc.body.innerText ? doc.body.innerText.length : 0),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 在页面上下文内发同源 fetch
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
    if (typeof diag.titleUnread === 'number' && diag.titleUnread >= 0) {
      return { unread: diag.titleUnread, source: 'title' };
    }
    if (typeof diag.folderCount === 'number' && diag.folderCount >= 0) {
      return { unread: diag.folderCount, source: 'folder-dom' };
    }
    if (diag.attrCandidates && diag.attrCandidates.length) {
      const vals = diag.attrCandidates.filter(v => v >= 0);
      if (vals.length) {
        return { unread: Math.min(...vals), source: 'attr-dom' };
      }
    }
    return { unread: null, source: 'none' };
  }

  /**
   * 判断当前页面类型
   */
  function classifyPage(diag, best) {
    const path = (location.pathname || '');
    const is163InboxPath = /js6\/main|main\.jsp|s\?func=mbox/i.test(path + ' ' + location.href);
    const isQQInboxPath = /cgi-bin\/(mail_list|frame_html|frame|mail|login|readdata)|home\/index/i.test(location.href);
    const hasMailTitle = /邮箱|mail|收件箱|未读/i.test(diag.title || '');
    const hasUnread = typeof best.unread === 'number';

    let pageType;
    if (hasUnread) {
      pageType = 'inbox';
    } else if (is163InboxPath || isQQInboxPath || hasMailTitle) {
      pageType = 'mailbox';
    } else {
      pageType = 'aux';
    }
    return { pageType, isTopFrame, hasUnread };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.type !== 'probeContent163' && message.type !== 'probeContentQQ')) {
      return false;
    }

    // 子 frame 无未读数据时不响应
    if (!isTopFrame) {
      try {
        const preDiag = extractUnreadFromDom();
        const preBest = computeBest(preDiag);
        if (typeof preBest.unread !== 'number') {
          return false;
        }
      } catch (e) {
        return false;
      }
    }

    (async () => {
      try {
        const diag = extractUnreadFromDom();
        const best = computeBest(diag);
        const sid = diag.sidFromUrl || diag.sidFromDom;
        const cls = classifyPage(diag, best);

        const detail = {
          provider: isQQ ? 'qq' : 'netease_163',
          host: HOST,
          documentReady: document.readyState,
          pageUrl: location.href,
          pageType: cls.pageType,
          isTopFrame: cls.isTopFrame,
          dom: diag,
          best,
        };

        const loggedIn = !!sid || !!best.unread;

        // 通知 SW 缓存 sid
        if (sid) {
          try {
            chrome.runtime.sendMessage({
              type: 'contentPageReady',
              detail: {
                host: HOST,
                url: location.href,
                sid,
                provider: isQQ ? 'qq' : 'netease_163',
              }
            }).catch(() => {});
          } catch (e) {}
        }

        sendResponse({
          success: true,
          loggedIn,
          authVerified: !!sid,
          needsInboxPage: cls.pageType !== 'inbox',
          pageType: cls.pageType,
          unreadCount: best.unread,
          unreadSource: best.source,
          sid: sid || null,
          detail,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // 异步
  });

  // 主动上报一次
  if (isTopFrame) {
    try {
      const diag = extractUnreadFromDom();
      const best = computeBest(diag);
      const cls = classifyPage(diag, best);
      chrome.runtime.sendMessage({
        type: 'contentPageReady',
        detail: {
          host: HOST,
          url: location.href,
          title: document.title,
          pageType: cls.pageType,
          unreadCount: best.unread,
          sid: diag.sidFromUrl || diag.sidFromDom,
          hasBody: !!(document.body && document.body.innerText),
        }
      }).catch(() => {});
    } catch (e) {}
  }
})();
