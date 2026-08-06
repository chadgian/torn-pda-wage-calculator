// ==UserScript==
// @name         Ghost Byte Wage Calculator Loader
// @namespace    wyn.torn.company.tools
// @version      1.2.1
// @description  Loads the Ghost Byte Torn PDA employee wage calculator.
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

  // jsDelivr normally works better inside Android WebView/Torn PDA than
  // raw.githubusercontent.com. Statically is included as a fallback.
  const SOURCES = [
    'https://cdn.jsdelivr.net/gh/chadgian/torn-pda-wage-calculator@main/src/',
    'https://cdn.statically.io/gh/chadgian/torn-pda-wage-calculator/main/src/',
  ];

  async function fetchPart(name) {
    let lastError;

    for (const base of SOURCES) {
      try {
        const response = await fetch(`${base}${name}?v=1.2.1`, {
          cache: 'no-store',
          credentials: 'omit',
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }

        return await response.text();
      } catch (error) {
        lastError = error;
        console.warn(`[Ghost Byte Wage Calculator] Could not load ${name} from ${base}`, error);
      }
    }

    throw new Error(`Could not download ${name}: ${lastError?.message || 'all download sources failed'}`);
  }

  async function decompressGzipBase64(base64) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This Torn PDA WebView does not support DecompressionStream. Update Torn PDA or Android System WebView.');
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

    // Indirect eval executes the downloaded userscript in the page context.
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
