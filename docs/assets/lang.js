/* Mail Notifier 站点多语言（中 / 英）切换
 *
 * 用法：
 *   1. <html lang="zh-CN" data-title-zh="…" data-title-en="…">  —— 声明 HTML lang 与双语标题
 *   2. <meta name="description" content="中文" data-desc-en="English">  —— 双语描述
 *   3. 任意元素加 data-zh / data-en 属性即可按语言切换文本（含 aria-label 等属性名）
 *   4. 含两套内容的页面（隐私政策 / 服务条款）用 #doc-zh / #doc-en 整块切换
 *   5. 语言切换按钮 #btn-zh / #btn-en（可选），切换结果记忆在 localStorage（键 mn-lang）
 *
 * 无 JS 时：默认渲染中文（#doc-en 带 hidden），data-en 元素保持中文文案，页面仍可正常阅读。
 */
(function () {
  var STORAGE_KEY = 'mn-lang';
  var lang = 'zh';

  function readSaved() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
      return null;
    }
  }

  function writeSaved(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      /* 忽略 */
    }
  }

  /* 浏览器语言偏好：zh 开头用中文，其余用英文 */
  function detectLang() {
    var saved = readSaved();
    if (saved === 'zh' || saved === 'en') return saved;
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  /* 是否为纯文本元素（除 data-zh / data-en 外没有 data-* 属性） */
  function isPlainTextNode(el) {
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name !== 'data-zh' && name !== 'data-en' && name.indexOf('data-') === 0) return false;
    }
    return true;
  }

  /* 按 data-zh / data-en 切换文本，并同步 data-<-属性名>-zh / -en 声明的属性值 */
  function applyDataAttrs(isZh) {
    var nodes = document.querySelectorAll('[data-zh][data-en]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var zhText = el.getAttribute('data-zh');
      var enText = el.getAttribute('data-en');
      if (isPlainTextNode(el)) el.textContent = isZh ? zhText : enText;

      // 例：data-aria-label-zh / data-aria-label-en 或 data-title-zh / data-title-en
      var attrs = el.attributes;
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name;
        if (name.indexOf('data-') !== 0 || name.indexOf('-en') !== name.length - 3) continue;
        var base = name.slice(5, name.length - 3);
        if (!base) continue;
        var zhAttr = 'data-' + base + '-zh';
        var zhValue = el.getAttribute(zhAttr);
        if (zhValue === null) continue;
        el.setAttribute(base, isZh ? zhValue : attrs[j].value);
      }
    }
  }

  /* 双语 <title> 与描述 */
  function applyMeta(isZh) {
    var root = document.documentElement;
    var titleZh = root.getAttribute('data-title-zh');
    var titleEn = root.getAttribute('data-title-en');
    if (titleZh && titleEn) document.title = isZh ? titleZh : titleEn;

    var desc = document.querySelector('meta[name="description"]');
    if (desc && desc.getAttribute('data-desc-en')) {
      if (!desc.getAttribute('data-desc-zh'))
        desc.setAttribute('data-desc-zh', desc.getAttribute('content') || '');
      desc.setAttribute(
        'content',
        isZh ? desc.getAttribute('data-desc-zh') : desc.getAttribute('data-desc-en')
      );
    }

    var ogTitle = document.querySelector('meta[property="og:title"][data-og-title-en]');
    if (ogTitle) {
      if (!ogTitle.getAttribute('data-og-title-zh')) {
        ogTitle.setAttribute('data-og-title-zh', ogTitle.getAttribute('content') || '');
      }
      ogTitle.setAttribute(
        'content',
        isZh ? ogTitle.getAttribute('data-og-title-zh') : ogTitle.getAttribute('data-og-title-en')
      );
    }

    var ogDesc = document.querySelector('meta[property="og:description"][data-og-desc-en]');
    if (ogDesc) {
      if (!ogDesc.getAttribute('data-og-desc-zh')) {
        ogDesc.setAttribute('data-og-desc-zh', ogDesc.getAttribute('content') || '');
      }
      ogDesc.setAttribute(
        'content',
        isZh ? ogDesc.getAttribute('data-og-desc-zh') : ogDesc.getAttribute('data-og-desc-en')
      );
    }
  }

  /* 双语文档块与切换按钮状态 */
  function applyBlocks(isZh) {
    var docZh = document.getElementById('doc-zh');
    var docEn = document.getElementById('doc-en');
    if (docZh) docZh.hidden = !isZh;
    if (docEn) docEn.hidden = isZh;

    var btnZh = document.getElementById('btn-zh');
    var btnEn = document.getElementById('btn-en');
    if (btnZh) btnZh.setAttribute('aria-pressed', String(isZh));
    if (btnEn) btnEn.setAttribute('aria-pressed', String(!isZh));
  }

  function setYear() {
    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  function apply(nextLang) {
    lang = nextLang === 'en' ? 'en' : 'zh';
    var isZh = lang === 'zh';
    document.documentElement.lang = isZh ? 'zh-CN' : 'en';
    document.documentElement.setAttribute('data-lang', lang);
    applyMeta(isZh);
    applyDataAttrs(isZh);
    applyBlocks(isZh);
    writeSaved(lang);
  }

  function bind() {
    var btnZh = document.getElementById('btn-zh');
    var btnEn = document.getElementById('btn-en');
    if (btnZh)
      btnZh.addEventListener('click', function () {
        apply('zh');
      });
    if (btnEn)
      btnEn.addEventListener('click', function () {
        apply('en');
      });
  }

  function init() {
    setYear();
    bind();
    apply(detectLang());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
