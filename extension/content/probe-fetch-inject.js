/**
 * probe-fetch-inject.js - 在页面上下文内执行 fetch 的脚本
 *
 * 此文件通过 chrome.scripting API 注入，可以绕过页面的 CSP 限制。
 */

(function () {
  // 从 chrome.runtime.getMessage 获取参数（MV3 方式）
  const params = chrome?.runtime?.message || window.__probeFetchParams;
  if (!params) {
    console.error('[probe-fetch] 缺少参数');
    return;
  }

  const { url, options, fnName } = params;
  window[fnName] = null;

  fetch(url, options || {})
    .then(async (resp) => {
      let text = '';
      try {
        text = await resp.text();
      } catch (e) {}
      const cb = window[fnName];
      if (cb) cb({ ok: resp.ok, status: resp.status, text: text.substring(0, 4000) });
    })
    .catch((err) => {
      const cb = window[fnName];
      if (cb) cb({ ok: false, error: String((err && err.message) || err) });
    });
})();
