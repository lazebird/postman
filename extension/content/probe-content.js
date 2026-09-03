/**
 * probe-content.js - 内容脚本（方案 C in-origin 探测）
 *
 * 混合方案核心：
 *   1. 内容脚本在邮箱页面（同源上下文）中运行，读取真实未读数
 *   2. 同时从页面 URL / DOM 提取 sid 会话令牌
 *   3. 将 sid 回传给 SW → SW 缓存 sid 后可独立调 API 进行后台检查
 *
 * 这样结合了两种优势：
 *   - 有页面时：内容脚本直接读 DOM（最可靠）
 *   - 无页面时：SW 用缓存 sid + Cookie 调 API（无需页面打开）
 */

(() => {
  // 避免重复注入
  if (window.__mailProbeContentLoaded__) return;
  window.__mailProbeContentLoaded__ = true;

  const HOST = location.host;
  const isQQ = HOST.includes('qq.com');
  // 判断当前 frame 是否为主（顶层）frame。
  // webmail 收件箱的主体内容通常渲染在顶层文档或主业务 iframe 中，
  // 而 /contacts/call.do 等子 frame 只有业务但无未读角标。区分可避免拿错 frame 的 null 结果。
  let isTopFrame = false;
  try { isTopFrame = window === window.top; } catch (e) { isTopFrame = false; }

  /**
   * 提取页面 DOM 中的未读数
   * 163 / QQ 网页版收件箱左侧列表通常会渲染「收件箱(未读数)」或未读角标。
   * 同时回传可能暴露 sid 的信息（iframe src / window 变量 / location.href）。
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

    // 6. 提取页面标题中的未读数（如 "(8封未读) 网易邮箱6.0版"）
    let titleUnread = null;
    const titleMatch = doc.title.match(/[\(（]\s*(\d+)\s*封?未读\s*[\)）]/);
    if (titleMatch) titleUnread = parseInt(titleMatch[1], 10);

    // 合并去重：优先 folder 计数
    const folderCount = candidates.find(c => c.type === 'folder');
    const attrCounts = candidates.filter(c => c.type === 'attr').map(c => c.value);

    // 收集所有候选值（去重后）
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
   * 在页面上下文内发同源 fetch（携带第一方 Cookie）
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
   * 优先：页面标题中的未读数 → DOM folder → attrCandidates
   */
  function computeBest(diag) {
    // 页面标题是最可靠的信号：如 "(8封未读) 网易邮箱6.0版"
    if (typeof diag.titleUnread === 'number' && diag.titleUnread >= 0) {
      return { unread: diag.titleUnread, source: 'title' };
    }
    if (typeof diag.folderCount === 'number' && diag.folderCount >= 0) {
      return { unread: diag.folderCount, source: 'folder-dom' };
    }
    if (diag.attrCandidates && diag.attrCandidates.length) {
      const vals = diag.attrCandidates.filter(v => v >= 0);
      if (vals.length) {
        // 保守估计取最小值
        return { unread: Math.min(...vals), source: 'attr-dom' };
      }
    }
    return { unread: null, source: 'none' };
  }

  /**
   * 判断当前页面是否为「能反映未读数」的主收件箱页面。
   * 163/QQ 登录后可能打开在收件箱、联系人、文件夹等子模块 iframe。
   * 只有主收件箱页面才会渲染「收件箱(未读数)」或含未读的标题。
   * 若当前 frame 不含未读数，则视为辅助 frame，不作为授权成功的依据（但 sid 仍有效）。
   */
  function classifyPage(diag, best) {
    // 判断页面 URL / title 是否指向主收件箱
    const path = (location.pathname || '');
    const is163InboxPath = /js6\/main|main\.jsp|s\?func=mbox/i.test(path + ' ' + location.href);
    const isQQInboxPath = /cgi-bin\/(mail_list|frame_html|login)/i.test(location.href);
    const hasMailTitle = /邮箱|mail|收件箱|未读/i.test(diag.title || '');
    const hasUnread = typeof best.unread === 'number';

    let pageType;
    if (hasUnread) {
      pageType = 'inbox'; // 能读到未读数 → 主收件箱
    } else if (is163InboxPath || isQQInboxPath || hasMailTitle) {
      pageType = 'mailbox'; // 是邮箱主框架但未解析到未读数
    } else {
      pageType = 'aux'; // 辅助 frame（联系人/设置等）
    }
    return { pageType, isTopFrame, hasUnread };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.type !== 'probeContent163' && message.type !== 'probeContentQQ')) {
      return false;
    }

    (async () => {
      try {
        const diag = extractUnreadFromDom();
        const best = computeBest(diag);
        // 获取 sid（URL 或 DOM）
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

        // 已登录判定：只要拿到 sid 即可认为登录态有效（可能命中辅助 frame）。
        // 能读到未读 → 强登录信号；只有 sid 而无未读 → 已授权但需切到收件箱主框架才能读数。
        const loggedIn = !!sid || !!best.unread;

        // 通过消息通知 SW 缓存 sid（内容脚本无法直接访问 chrome.storage.session）
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
          } catch (e) {
            // 发送失败不影响探测结果
          }
        }

        sendResponse({
          success: true,
          loggedIn,
          // 明确标记是否已授权（拿到 sid）与是否能读到未读数
          authVerified: !!sid,
          needsInboxPage: cls.pageType !== 'inbox',
          pageType: cls.pageType,
          unreadCount: best.unread,
          unreadSource: best.source,
          sid: sid || null,  // 显式返回 sid
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
  } catch (e) { /* SW 未就绪时忽略 */ }
})();
