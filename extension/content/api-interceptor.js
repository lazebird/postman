/**
 * api-interceptor.js - API 请求拦截器（独立文件，绕过 CSP）
 *
 * 此文件通过 chrome.scripting API 注入，可以绕过页面的 CSP 限制。
 */

(function() {
  if (window.__mailApiInterceptorInstalled__) return;
  window.__mailApiInterceptorInstalled__ = true;

  const MAX_BODY_LEN = 4000;
  const MAX_PATTERNS = 200;
  const recentUrls = new Set();

  function isRelevant(u) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname;
      if (!/(^|\.)(163\.com|qq\.com|ustc\.edu\.cn)$/i.test(host)) return false;
    } catch (e) { return false; }
    if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)([?#]|$)/i.test(u)) return false;
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
          if (/^cookie$/i.test(k)) continue;
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

  // 拦截 fetch
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

  // 拦截 XHR
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

  // 拦截 sendBeacon
  const origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (origBeacon) {
    navigator.sendBeacon = function(url, data) {
      try { record({ type: 'beacon', url, method: 'POST', body: data && String(data) }); }
      catch (e) {}
      return origBeacon(url, data);
    };
  }

  // 拦截 EventSource
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
