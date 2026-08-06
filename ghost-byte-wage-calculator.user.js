// ==UserScript==
// @name         Ghost Byte Wage Calculator Loader
// @namespace    wyn.torn.company.tools
// @version      1.2.2
// @description  Loads the Ghost Byte Torn PDA employee wage calculator using Torn PDA's native HTTP bridge.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/companies.php*
// @match        https://www.torn.com/joblist.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const PDA_API_KEY = '###PDA-APIKEY###';
  const PARTS = [
    'ghost-byte-wage-calculator.part01.b64',
    'ghost-byte-wage-calculator.part02.b64',
  ];

  const SOURCES = [
    'https://cdn.jsdelivr.net/gh/chadgian/torn-pda-wage-calculator@main/src/',
    'https://raw.githubusercontent.com/chadgian/torn-pda-wage-calculator/main/src/',
  ];

  function getPdaHttpGet() {
    if (typeof window.PDA_httpGet === 'function') {
      return window.PDA_httpGet.bind(window);
    }

    if (typeof PDA_httpGet === 'function') {
      return PDA_httpGet;
    }

    return null;
  }

  async function requestText(url) {
    const pdaHttpGet = getPdaHttpGet();

    if (pdaHttpGet) {
      const response = await pdaHttpGet(url, {
        Accept: 'text/plain,*/*',
        'Cache-Control': 'no-cache',
      });

      const status = Number(response?.status || 200);
      const text = response?.responseText ?? response?.body ?? response?.text;

      if (status < 200 || status >= 300) {
        throw new Error(`PDA HTTP ${status}`);
      }

      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('PDA HTTP returned an empty response');
      }

      return text;
    }

    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  async function fetchPart(name) {
    let lastError;

    for (const base of SOURCES) {
      try {
        return await requestText(`${base}${name}?v=1.2.2`);
      } catch (error) {
        lastError = error;
        console.warn(`[Ghost Byte Wage Calculator] Could not load ${name} from ${base}`, error);
      }
    }

    throw new Error(`Could not download ${name}: ${lastError?.message || 'all sources failed'}`);
  }

  async function decompressGzipBase64(base64) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Update Android System WebView and Torn PDA, then try again.');
    }

    const compressed = Uint8Array.from(
      atob(base64.replace(/\s+/g, '')),
      (character) => character.charCodeAt(0)
    );

    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));

    return new Response(stream).text();
  }

  async function loadCalculator() {
    const responses = await Promise.all(PARTS.map(fetchPart));
    let source = await decompressGzipBase64(responses.join(''));

    if (PDA_API_KEY && !PDA_API_KEY.includes('###PDA-APIKEY###')) {
      source = source.replaceAll('###PDA-APIKEY###', PDA_API_KEY);
    }

    (0, eval)(`${source}\n//# sourceURL=ghost-byte-wage-calculator.full.user.js`);
  }

  loadCalculator().catch((error) => {
    console.error('[Ghost Byte Wage Calculator]', error);

    const message = document.createElement('div');
    message.textContent = `Wage Calculator failed to load: ${error.message}`;
    message.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:80px',
      'z-index:2147483647',
      'max-width:320px',
      'padding:10px 12px',
      'border-radius:8px',
      'background:#5b1e1e',
      'color:#fff',
      'font:700 12px Arial',
      'line-height:1.4',
      'box-shadow:0 4px 16px rgba(0,0,0,.4)',
    ].join(';');

    document.body.appendChild(message);
    setTimeout(() => message.remove(), 12000);
  });
})();
