/* 语言切换 + 页脚年份（隐私政策 / 服务条款共用） */
(function () {
  var btnZh = document.getElementById('btn-zh');
  var btnEn = document.getElementById('btn-en');
  var docZh = document.getElementById('doc-zh');
  var docEn = document.getElementById('doc-en');

  function apply(lang) {
    var zh = lang !== 'en';
    if (docZh) docZh.hidden = !zh;
    if (docEn) docEn.hidden = zh;
    if (btnZh) btnZh.setAttribute('aria-pressed', String(zh));
    if (btnEn) btnEn.setAttribute('aria-pressed', String(!zh));
    document.documentElement.lang = zh ? 'zh-CN' : 'en';
    try {
      localStorage.setItem('mn-lang', zh ? 'zh' : 'en');
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  }

  function init() {
    var saved = null;
    try {
      saved = localStorage.getItem('mn-lang');
    } catch (e) {
      saved = null;
    }
    if (!saved) {
      saved = (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    }
    apply(saved);
  }

  if (btnZh)
    btnZh.addEventListener('click', function () {
      apply('zh');
    });
  if (btnEn)
    btnEn.addEventListener('click', function () {
      apply('en');
    });

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  init();
})();
