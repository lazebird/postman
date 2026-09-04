/**
 * probe-fetch-inject.js - 在页面上下文内执行 fetch 的脚本
 * 
 * 此文件通过 chrome.scripting API 注入，可以绕过页面的 CSP 限制。
 */

(function(params) {
  const { url, options, fnName } = params;
  const __r = (window.__mailProbeResult) || [];
  window[fnName] = null;
  
  fetch(url, options || {})
    .then(async (resp) => {
      let text = '';
      try { text = await resp.text(); } catch(e) {}
      const cb = window[fnName];
      if (cb) cb({ ok: resp.ok, status: resp.status, text: text.substring(0, 4000) });
    })
    .catch((err) => {
      const cb = window[fnName];
      if (cb) cb({ ok: false, error: String(err && err.message || err) });
    });
})(chrome.scripting.getInjectionParameters ? chrome.scripting.getInjectionParameters() : arguments[0]);
