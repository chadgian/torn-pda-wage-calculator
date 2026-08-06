// ==UserScript==
// @name         Ghost Byte Wage Calculator Loader
// @namespace    wyn.torn.company.tools
// @version      1.2.0
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
  const BASE = 'https://raw.githubusercontent.com/chadgian/torn-pda-wage-calculator/main/src/';
  const PARTS = [
    'ghost-byte-wage-calculator.part01.b64',
    'ghost-byte-wage-calculator.part02.b64',
  ];

  async function loadCalculator() {
    const responses = await Promise.all(
      PARTS.map(async (name) => {
        const response = await fetch(BASE + name, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Could not load ${name} (${response.status})`);
        }
        return response.text();
      })
    );

    const base64 = responses.join('').replace(/\s+/g, '');
    const compressed = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    let source = await new Response(stream).text();

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
    message.style.cssText = 'position:fixed;right:12px;bottom:80px;z-index:2147483647;max-width:300px;padding:10px 12px;border-radius:8px;background:#5b1e1e;color:#fff;font:700 12px Arial;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(message);
    setTimeout(() => message.remove(), 8000);
  });
})();
