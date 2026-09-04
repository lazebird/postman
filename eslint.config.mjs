// ESLint 扁平配置（Flat Config, ESLint 9）
//
// 适用对象：
//   - extension/    MV3 浏览器扩展（service worker / content script / popup / options）
//     运行在 Chrome 环境，使用 chrome.* 全局 API；content/popup/options 用到 DOM 全局。
//   - scripts/      Node.js 脚本
//
// 设计取舍：
//   - no-undef 保持 error：能捕获真实的「未导入即调用」类缺陷（如曾漏 import getDebugLogs）。
//   - no-empty 降级为 warn（容忍刻意为之的空 catch）；no-useless-escape 关闭，
//     避免其自动修复误动遗留代码中工作正常的正则。
//   - no-unused-vars 忽略 catch 捕获参数（caughtErrors: 'none'），减少空 catch(e) 的噪音告警。
//   - 格式化交由 Prettier，CI 中先 prettier 后 eslint，顺序固定。
//   - eslint / prettier 依赖使用精确版本（无 ^），并配合 package-lock.json 保证
//     不同本地环境安装到完全一致的版本，消除「环境差异导致规则行为不一致」的问题。
import js from '@eslint/js';

/** 浏览器/标准 Web API 全局（Chrome MV3 的 SW、内容脚本与扩展页面共享大部分） */
const webGlobals = {
  // Chrome 扩展 API
  chrome: 'readonly',
  // DOM / Window
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  screen: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  // DOM/Web types
  HTMLElement: 'readonly',
  HTMLCollection: 'readonly',
  Node: 'readonly',
  NodeFilter: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MutationObserver: 'readonly',
  XMLHttpRequest: 'readonly',
  AbortController: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  fetch: 'readonly',
  performance: 'readonly',
  createImageBitmap: 'readonly',
  OffscreenCanvas: 'readonly',
  ImageData: 'readonly',
  // 定时器
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  // 其它标准
  console: 'readonly',
  Promise: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'doc/**', 'known-issues.md'] },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: webGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      // 保持 error：缺全局引用是真实缺陷
      'no-undef': 'error',
      // 容忍刻意为之的空 catch 与正则转义（遗留代码常见、语义无害）
      'no-empty': 'warn',
      'no-useless-escape': 'off',
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': 'warn',
      'no-useless-escape': 'off',
      'no-console': 'off',
    },
  },
];
