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

  // ---- document_start 就绪辅助 ----
  // run_at 改为 document_start 后，内容脚本注入时 document.body 尚不存在，
  // 所有依赖 DOM 的探测/上报需等 body 就绪后再执行。
  const bodyReady = new Promise((resolve) => {
    if (document.body) return resolve();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function onReady() {
        document.removeEventListener('DOMContentLoaded', onReady);
        resolve();
      });
    } else {
      // 兜底轮询
      let tries = 0;
      const t = setInterval(() => {
        if (document.body || ++tries > 100) { clearInterval(t); resolve(); }
      }, 50);
    }
  });
  function waitForBody() { return bodyReady; }
  const isQQ = HOST.includes('qq.com');
  const is163 = HOST.includes('163.com');
  // 判断当前 frame 是否为主（顶层）frame。
  let isTopFrame = false;
  try { isTopFrame = window === window.top; } catch (e) { isTopFrame = false; }

  // ============================================================
  // API 请求拦截器（main world 注入）
  // ============================================================
  // 在页面主世界注入脚本，拦截 fetch / XHR / sendBeacon / EventSource
  // 等真实请求，记录 URL/method/headers/body 后回传给内容脚本。
  // v0.9.1 大幅放宽捕获过滤 + 覆盖更多请求通道 + 所有 frame 独立上报，
  // 修复「打开邮箱页却捕获不到真实 API」导致的捕获断链。
  const API_INTERCEPTOR_SCRIPT = `
    (function() {
      if (window.__mailApiInterceptorInstalled__) return;
      window.__mailApiInterceptorInstalled__ = true;

      // 为避免数据膨胀设上限；放宽到更多条以便捕捉到真实未读接口
      const MAX_BODY_LEN = 4000;
      const MAX_PATTERNS = 200;
      const recentUrls = new Set();

      // 命中目标邮箱的任意子域/路径（163.com / qq.com）
      // 排除纯静态资源与已知 CDN/资源域，其余 API 一律捕获
      function isRelevant(u) {
        try {
          const parsed = new URL(u);
          const host = parsed.hostname;
          if (!/(^|\.)(163\.com|qq\.com)$/i.test(host)) return false;
        } catch (e) { return false; }
        // 排除静态资源后缀
        if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)([?#]|$)/i.test(u)) return false;
        // 排除已知纯静态/CDN/资源类主机路径片段
        if (/(rescdn|qpic|gtimg|alicdn|gslb|exmailcdn|static\.|\.css|\.js|\.png|\.gif|fonts|images?|comm|skin|style)/i.test(u)) return false;
        return true;
      }

      function reportCapture(capture) {
        try { window.postMessage({ source: '__mailApiCapture__', capture }, '*'); } catch (e) {}
      }

      function record(entry) {
        try {
          const full = new URL(entry.url, location.href).href;
          if (!isRelevant(full)) return;
          const key = entry.method + ' ' + full + ' ' + String(entry.body || '');
          if (recentUrls.has(key)) return;
          if (recentUrls.size >= MAX_PATTERNS) recentUrls.delete(recentUrls.values().next().value);
          recentUrls.add(key);
          const headers = {};
          if (entry.headers) {
            for (const [k, v] of Object.entries(entry.headers)) {
              if (/^cookie$/i.test(k)) continue; // Cookie 头由 credentials/网络层处理，不落盘
              headers[k] = v;
            }
          }
          reportCapture({
            type: entry.type || 'fetch',
            url: full,
            method: entry.method || 'GET',
            body: entry.body ? String(entry.body).substring(0, MAX_BODY_LEN) : null,
            headers,
            timestamp: Date.now(),
          });
        } catch (e) {}
      }

      // ---- 拦截 fetch ----
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function(...args) {
          try {
            const arg0 = args[0];
            let url = typeof arg0 === 'string' ? arg0 : (arg0 && arg0.url) || '';
            const opts = args[1] || {};
            let method = opts.method || (typeof arg0 === 'object' && arg0.method) || 'GET';
            let body = opts.body != null ? opts.body : null;
            let headers = {};
            if (opts.headers) {
              try {
                if (opts.headers instanceof Headers) opts.headers.forEach((v, k) => { headers[k] = v; });
                else if (typeof opts.headers === 'object') headers = { ...opts.headers };
              } catch (e) {}
            }
            record({ type: 'fetch', url, method, body, headers });
          } catch (e) {}
          return origFetch.apply(this, args);
        };
      }

      // ---- 拦截 XHR ----
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        try { this.__mailApiUrl = new URL(url, location.href).href; }
        catch (e) { this.__mailApiUrl = url; }
        this.__mailApiMethod = method || 'GET';
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        try { record({ type: 'xhr', url: this.__mailApiUrl || '', method: this.__mailApiMethod || 'GET', body }); }
        catch (e) {}
        return origSend.apply(this, arguments);
      };

      // ---- 拦截 sendBeacon ----
      const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      if (origBeacon) {
        navigator.sendBeacon = function(url, data) {
          try { record({ type: 'beacon', url, method: 'POST', body: data && String(data) }); }
          catch (e) {}
          return origBeacon(url, data);
        };
      }

      // ---- 拦截 EventSource ----
      try {
        const OrigES = window.EventSource;
        if (OrigES) {
          window.EventSource = function(url, cfg) {
            try { record({ type: 'eventsource', url, method: 'GET', body: null }); } catch (e) {}
            return new OrigES(url, cfg);
          };
        }
      } catch (e) {}
    })();
  `;

  // 在所有 frame 中注入拦截器（各 frame 各自捕获其内发出的 API 调用）
  try {
    const s = document.createElement('script');
    s.textContent = API_INTERCEPTOR_SCRIPT;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {
    // 注入失败不阻塞主功能
  }

  // 捕获计数（供日志/上报确认捕获是否真正工作）
  let apiCaptureCount = 0;

  // API 捕获批量发送队列（每 frame 独立上报，含 iframe）
  let captureQueue = [];
  let captureFlushTimer = null;
  const FLUSH_INTERVAL = 1500;

  // 接收页面 main world 发送的 API 捕获数据
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== '__mailApiCapture__') return;
    const capture = event.data.capture;
    if (!capture || !capture.url) return;

    apiCaptureCount++;
    // 从本 frame URL 提取 sid 用于占位符替换；若本 frame 没有，保留 undefined 由 SW 用已知 sid 替换
    const urlSid = (location.href.match(/[?&]sid=([a-zA-Z0-9_\-]{8,})/) || [])[1] || null;
    const enriched = { ...capture, currentSid: urlSid || undefined };

    // 入队批量发送（不再局限于顶层 frame，所有 frame 都独立上报）
    captureQueue.push(enriched);
    if (!captureFlushTimer) {
      captureFlushTimer = setTimeout(() => {
        captureFlushTimer = null;
        if (captureQueue.length > 0) {
          const batch = captureQueue.splice(0, captureQueue.length);
          const provider = isQQ ? 'qq' : is163 ? 'netease_163' : null;
          if (provider) {
            try {
              chrome.runtime.sendMessage({
                type: 'apiCaptureBatch',
                provider,
                captures: batch,
                fromFrame: isTopFrame ? 'top' : 'sub',
                frameUrl: location.href,
                totalCaptured: apiCaptureCount,
              }).catch(() => {});
            } catch (e) {}
          }
        }
      }, FLUSH_INTERVAL);
    }
    // 限制队列长度
    if (captureQueue.length > 60) captureQueue = captureQueue.slice(-60);
  });

  // 顶层 frame 定期上报本页捕获总数，供 SW 以日志确认捕获链路工作
  let lastReportedCount = 0;
  const countTimer = setInterval(() => {
    if (apiCaptureCount > lastReportedCount && isTopFrame) {
      lastReportedCount = apiCaptureCount;
      try {
        chrome.runtime.sendMessage({
          type: 'apiCaptureCount',
          provider: isQQ ? 'qq' : is163 ? 'netease_163' : null,
          count: apiCaptureCount,
          host: HOST,
        }).catch(() => {});
      } catch (e) {}
    }
  }, 5000);
  // 不阻止页面卸载清理

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

  /**
   * 计算「当前页面在跳转链路中的位置」(nav-stage)
   *
   * 背景：邮箱页面从打开到最终呈现邮件内容会经过多级跳转，例如：
   *   - QQ： mail.qq.com → (未登录) ptlogin2 登录页 / (已登录) wx.mail.qq.com 网页版
   *   - 163：mail.163.com → js6/main.jsp → 收件箱内容
   * 内容脚本可能在跳转链路的任意一段被注入（含登录重定向页、SPA 加载中的中间页）。
   * 此处综合当前 URL、document.referrer（谁跳转来）、readyState、frame 角色、
   * 是否拿到 sid / 是否读到未读，粗判当前页面处于哪一段，供日志确认
   * 「跳转最终呈现邮件内容」是否走通。
   */
  function getNavContext(diag, best) {
    const href = location.href;
    const referrer = document.referrer || '';
    const path = location.pathname || '';
    const readyState = document.readyState;
    const title = diag ? (diag.title || '') : (document.title || '');
    const hasSid = !!(diag && (diag.sidFromUrl || diag.sidFromDom));
    const hasUnread = best && typeof best.unread === 'number';

    // 粗判阶段：跳转链路中的角色
    let stage = 'unknown';

    const loginRe = /ptlogin|ssl\.ptlogin|login\.qq|xui\.qq|passport|login|cas|sso/i;
    const app163Re = /js6|main\.jsp|s\?func=mbox|func=mbox|mbox/i;
    const appQQRe = /wx\.mail\.qq\.com|cgi-bin\/(mail_list|frame_html|frame|mail|readdata)|home\/index/i;

    if (isQQ) {
      if (loginRe.test(href) && !/wx\.mail\.qq\.com/i.test(href)) stage = 'login-redirect';
      else if (/wx\.mail\.qq\.com/i.test(href) || appQQRe.test(href)) stage = 'webmail-app';
      else if (/mail\.qq\.com/i.test(href)) stage = 'entry';
    } else if (is163) {
      if (loginRe.test(href) && !app163Re.test(href)) stage = 'login-redirect';
      else if (app163Re.test(href)) stage = 'webmail-app';
      else if (/163\.com/i.test(href)) stage = 'entry';
    }

    // 是否能读到内容（未读 or 拿到 sid 判定在 app 域）
    const contentReached = hasUnread || (hasSid && /webmail-app/.test(stage));

    return {
      href,
      referrer,
      path,
      readyState,
      title,
      stage,
      hasSid,
      hasUnread,
      contentReached,
      frameRole: isTopFrame ? 'top' : 'sub',
      // 上一跳(经 referrer)是否也是本邮箱域内 → 用于确认是否为「站内跳转链」
      redirectFromMailDomain: (referrer && /(^|\.)(163\.com|qq\.com)$/i.test(
        (function(){ try { return new URL(referrer).hostname; } catch(e){ return ''; } })()
      )) || false,
    };
  }

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
        await waitForBody(); // document_start 下等待 body 就绪后再读 DOM
        const diag = extractUnreadFromDom();
        const best = computeBest(diag);
        const sid = diag.sidFromUrl || diag.sidFromDom;
        const cls = classifyPage(diag, best);

        const nav = getNavContext(diag, best);
        const detail = {
          provider: isQQ ? 'qq' : 'netease_163',
          host: HOST,
          documentReady: document.readyState,
          pageUrl: location.href,
          pageType: cls.pageType,
          isTopFrame: cls.isTopFrame,
          dom: diag,
          best,
          nav,
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
                referrer: document.referrer || '',
                navStage: nav.stage,
                readyState: document.readyState,
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

  // 主动上报一次（document_start 下等 body 就绪后再读 DOM；拦截器已在注入早期就位）
  if (isTopFrame) {
    (async () => {
      await waitForBody();
      try {
        const diag = extractUnreadFromDom();
        const best = computeBest(diag);
        const cls = classifyPage(diag, best);
        const nav = getNavContext(diag, best);
        chrome.runtime.sendMessage({
          type: 'contentPageReady',
          detail: {
            host: HOST,
            url: location.href,
            referrer: document.referrer || '',
            title: document.title,
            navStage: nav.stage,
            readyState: document.readyState,
            contentReached: nav.contentReached,
            frameRole: nav.frameRole,
            pageType: cls.pageType,
            unreadCount: best.unread,
            sid: diag.sidFromUrl || diag.sidFromDom,
            hasBody: !!(document.body && document.body.innerText),
          }
        }).catch(() => {});
      } catch (e) {}
    })();
  }
})();
