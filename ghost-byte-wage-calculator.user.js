// ==UserScript==
// @name         Ghost Byte Wage Calculator
// @namespace    wyn.torn.company.tools
// @version      1.4.0
// @description  Self-contained Torn PDA wage calculator with a draggable launcher, exclusions, role suggestions, help, and optional wage autofill.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @include      https://www.torn.com/*
// @include      https://torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const ID = 'ghost-byte-wage-calculator';
  const API_KEY = '###PDA-APIKEY###';
  const STORE = `${ID}:v140`;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const cash = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const defaults = {
    mode: 'current', fixedBudget: 10000000, benchmark: 1000000,
    targetEff: 100, statWeight: 35, effWeight: 65,
    minWage: 0, maxWage: 25000000, roundTo: 10000,
    includeDirector: true, autoFill: false,
  };

  const help = {
    mode: ['Payment model', 'Current payroll redistributes the included employees’ present wage pool. Fixed budget distributes the amount you enter. Benchmark multiplies each employee score by the benchmark wage.'],
    fixedBudget: ['Fixed daily payroll', 'Used only with Fixed budget. This entire amount is divided among included employees. Excluded employees keep their existing wage outside this pool.'],
    benchmark: ['Benchmark daily wage', 'Used only with Benchmark. An employee whose score is 1.00 receives approximately this amount before limits and rounding.'],
    targetEff: ['Target effectiveness', 'The effectiveness value treated as 1.00. At the default of 100, an employee with 100 effectiveness has a performance index of 1.00.'],
    statWeight: ['Work-stat weight', 'Controls how strongly MAN + INT + END influence the score. Work stats are compared with the median of included employees using logarithmic scaling.'],
    effWeight: ['Effectiveness weight', 'Controls how strongly current total effectiveness influences the score. The two weights are automatically converted into proportions.'],
    minWage: ['Minimum wage', 'The lowest recommended daily wage for an included employee, unless the chosen total budget cannot mathematically support it.'],
    maxWage: ['Maximum wage', 'The highest recommended daily wage. The default is $25,000,000.'],
    roundTo: ['Round wages to', 'Rounds recommendations to a clean increment, such as the nearest $10,000.'],
    includeDirector: ['Include director', 'When off, the director remains visible but is excluded from the median, employee scores, and wage distribution.'],
    autoFill: ['Autofill wage field', 'When enabled, clicking an employee causes the script to fill the visible wage textbox with the suggestion. It never presses Update, Save, or Submit.'],
  };

  const cyberRoles = [
    ['Developer', 'intelligence', 24000, 'endurance', 12000],
    ['Tester', 'intelligence', 12000, 'endurance', 6000],
    ['Graphic Designer', 'intelligence', 18000, 'endurance', 9000],
    ['Apprentice', 'intelligence', 6000, 'endurance', 3000],
    ['Cleaner', 'manual', 12000, 'endurance', 6000],
    ['Lead Developer', 'endurance', 48000, 'intelligence', 24000],
    ['Analyst', 'endurance', 36000, 'intelligence', 18000],
  ];

  let settings = load('settings', defaults);
  let excluded = new Set(load('excluded', []));
  let employees = [];
  let loading = false;
  let error = '';
  let selectedId = '';
  let latestRows = [];
  let settingsOpen = false;

  function load(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(`${STORE}:${key}`));
      if (Array.isArray(fallback)) return Array.isArray(value) ? value : [...fallback];
      return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback };
    } catch (_) { return Array.isArray(fallback) ? [...fallback] : { ...fallback }; }
  }
  function save(key, value) { localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value)); }
  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function sum(a, fn) { return a.reduce((t, x) => t + n(fn(x)), 0); }
  function median(a) { const x = a.filter(Number.isFinite).sort((p, q) => p - q); const m = Math.floor(x.length / 2); return !x.length ? 1 : x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; }
  function roundWage(v) { const step = Math.max(1, n(settings.roundTo)); return Math.round(v / step) * step; }
  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

  function normalize(collection) {
    const pairs = Array.isArray(collection) ? collection.map((x, i) => [x?.id ?? x?.user_id ?? i, x]) : Object.entries(collection || {});
    return pairs.map(([fallback, raw]) => {
      const ws = raw?.working_stats || raw?.work_stats || raw?.stats || {};
      const user = raw?.user && typeof raw.user === 'object' ? raw.user : {};
      const pos = typeof raw?.position === 'object' ? raw.position.name || raw.position.title : raw?.position || raw?.role || 'Unassigned';
      const manual = n(ws.manual_labor ?? ws.manual ?? raw?.manual_labor ?? raw?.manual ?? raw?.man);
      const intelligence = n(ws.intelligence ?? ws.intel ?? raw?.intelligence ?? raw?.intel ?? raw?.int);
      const endurance = n(ws.endurance ?? ws.end ?? raw?.endurance ?? raw?.end);
      const source = raw?.effectiveness ?? raw?.efficiency ?? 0;
      let effectiveness = n(source);
      if (source && typeof source === 'object') {
        effectiveness = n(source.total ?? source.overall ?? source.effectiveness ?? source.value);
        if (!effectiveness) effectiveness = sum(Object.values(source), v => v);
      }
      return {
        id: String(raw?.id ?? raw?.user_id ?? raw?.player_id ?? user.id ?? fallback),
        name: String(raw?.name ?? raw?.username ?? user.name ?? `Employee ${fallback}`),
        position: String(pos), manual, intelligence, endurance,
        total: manual + intelligence + endurance, effectiveness,
        wage: n(raw?.wage ?? raw?.salary ?? raw?.daily_wage ?? raw?.pay),
        director: Boolean(raw?.is_director) || /director/i.test(String(pos)),
      };
    });
  }

  async function fetchEmployees() {
    if (!API_KEY || API_KEY.includes('###PDA-APIKEY###')) throw new Error('Torn PDA did not supply an API key. Configure a Limited or Custom key with company employee access.');
    const response = await fetch(`https://api.torn.com/v2/company/employees?key=${encodeURIComponent(API_KEY)}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Torn API request failed (${response.status}).`);
    const data = await response.json();
    if (data?.error) throw new Error(data.error.error || data.error.message || 'Torn API error.');
    const rows = normalize(data?.employees ?? data?.company_employees ?? data?.companyEmployees ?? []);
    if (!rows.length) throw new Error('No employees were returned. Confirm that the key belongs to the company director.');
    return rows;
  }

  function roleSuggestion(e) {
    let best = null;
    for (const [name, p, pr, s, sr] of cyberRoles) {
      const fit = Math.min(e[p] / pr, e[s] / sr);
      const balance = Math.min(e[p] / pr, 2) * .7 + Math.min(e[s] / sr, 2) * .3;
      const score = fit >= 1 ? 10 + balance : balance;
      if (!best || score > best.score) best = { name, score, fit };
    }
    return best ? `${best.name}${best.fit < 1 ? ' (developing)' : ''}` : 'General staff';
  }

  function calculate() {
    const eligible = employees.filter(e => !excluded.has(e.id) && (settings.includeDirector || !e.director));
    const med = Math.max(1, median(eligible.map(e => e.total)));
    const sw = Math.max(0, n(settings.statWeight));
    const ew = Math.max(0, n(settings.effWeight));
    const wt = sw + ew || 1;
    const scored = eligible.map(e => {
      const statIndex = clamp(Math.log1p(e.total) / Math.log1p(med), .35, 2.25);
      const effIndex = clamp(e.effectiveness / Math.max(1, n(settings.targetEff)), 0, 2.5);
      return { ...e, score: Math.max(.01, (statIndex * sw + effIndex * ew) / wt) };
    });

    if (settings.mode === 'benchmark') {
      scored.forEach(e => e.suggested = roundWage(clamp(n(settings.benchmark) * e.score, n(settings.minWage), n(settings.maxWage))));
    } else {
      const budget = settings.mode === 'fixed' ? Math.max(0, n(settings.fixedBudget)) : sum(scored, e => e.wage);
      const min = Math.max(0, n(settings.minWage));
      const max = Math.max(min, n(settings.maxWage));
      const scoreTotal = sum(scored, e => e.score) || 1;
      const guaranteed = Math.min(budget, min * scored.length);
      const remaining = Math.max(0, budget - guaranteed);
      scored.forEach(e => e.suggested = roundWage(clamp((scored.length ? guaranteed / scored.length : 0) + remaining * e.score / scoreTotal, min, max)));
      const step = Math.max(1, n(settings.roundTo));
      let diff = roundWage(budget - sum(scored, e => e.suggested));
      const ordered = [...scored].sort((a, b) => diff >= 0 ? b.score - a.score : a.score - b.score);
      let guard = 0;
      while (Math.abs(diff) >= step && ordered.length && guard++ < 500) {
        const e = ordered[guard % ordered.length];
        const next = e.suggested + (diff > 0 ? step : -step);
        if (next >= min && next <= max) { e.suggested = next; diff += diff > 0 ? -step : step; }
      }
    }

    const map = new Map(scored.map(e => [e.id, e]));
    latestRows = employees.map(e => {
      const found = map.get(e.id);
      const omitted = excluded.has(e.id) || (!settings.includeDirector && e.director);
      const suggested = found?.suggested ?? e.wage;
      return { ...(found || e), omitted, suggested, change: suggested - e.wage, role: roleSuggestion(e) };
    });
    return { rows: latestRows, current: sum(latestRows, e => e.wage), suggested: sum(latestRows, e => e.suggested), med };
  }

  function installStyles() {
    if ($(`#${ID}-style`)) return;
    const style = document.createElement('style');
    style.id = `${ID}-style`;
    style.textContent = `
#${ID}-button{position:fixed;right:14px;bottom:96px;z-index:2147483646;border:2px solid #85efb7;border-radius:999px;padding:12px 16px;background:#075c3a;color:#fff;font:800 14px Arial,sans-serif;box-shadow:0 4px 18px #000b;touch-action:none;user-select:none;-webkit-user-select:none;display:block!important;visibility:visible!important;opacity:1!important}
#${ID}-overlay{display:none;position:fixed;inset:0;z-index:2147483647;background:#000c;overflow:auto;padding:10px;box-sizing:border-box;font-family:Arial,sans-serif;color:#fff}#${ID}-overlay.open{display:block}
#${ID}-panel{max-width:1150px;margin:0 auto 40px;background:#15191d;border:1px solid #68727c;border-radius:12px;overflow:hidden}.gb-head{display:flex;justify-content:space-between;align-items:center;padding:14px;background:#080a0c;border-bottom:1px solid #555}.gb-title{font-size:18px;font-weight:800}.gb-sub,.gb-note{color:#e0e4e7;font-size:12px}.gb-tools{display:flex;flex-wrap:wrap;gap:7px;padding:11px;background:#22272c}.gb-btn{border:1px solid #7d8791;border-radius:7px;padding:9px 11px;background:#343b42;color:#fff;font-weight:800}.gb-primary{background:#086642}.gb-settings{display:none;padding:12px;background:#1d2227}.gb-settings.open{display:block}.gb-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.gb-field label{display:flex;align-items:center;gap:5px;color:#fff;font-size:12px;font-weight:800;margin-bottom:5px}.gb-field input,.gb-field select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #8a949e;border-radius:7px;background:#050607;color:#fff;font-size:14px}.gb-q{width:20px;height:20px;padding:0;border:1px solid #aeb7c0;border-radius:50%;background:#48515a;color:#fff;font-weight:900}.gb-help{display:none;margin-top:6px;padding:8px;border:1px solid #6d7882;border-radius:7px;background:#07090b;color:#fff;font-size:12px;line-height:1.45}.gb-help.open{display:block}.gb-check{display:flex;align-items:center;gap:7px;padding-top:23px}.gb-error{margin:12px;padding:10px;background:#5c1e1e;border:1px solid #e17d7d;border-radius:7px}.gb-status{padding:14px}.gb-summary{display:grid;grid-template-columns:repeat(4,minmax(135px,1fr));gap:8px;padding:12px}.gb-card{padding:10px;background:#272d33;border:1px solid #606b75;border-radius:8px}.gb-card small{display:block;color:#e1e5e8}.gb-card b{display:block;margin-top:4px;color:#fff;font-size:16px}.gb-wrap{overflow:auto;padding:0 12px 15px}.gb-table{width:100%;min-width:1120px;border-collapse:collapse;font-size:12px}.gb-table th{position:sticky;top:0;background:#07090b;color:#fff;padding:9px 7px;border-bottom:1px solid #777;white-space:nowrap}.gb-table td{padding:9px 7px;background:#171c21;color:#fff;border-bottom:1px solid #444;text-align:right;white-space:nowrap}.gb-table tr:nth-child(even) td{background:#101418}.gb-table th:nth-child(-n+4),.gb-table td:nth-child(-n+4){text-align:left}.gb-table a{color:#8bd1ff!important;font-weight:800}.gb-omitted td{opacity:.65}.gb-up{color:#8af0b1!important}.gb-down{color:#ff9b9b!important}.gb-editor{background:#15191d!important;color:#fff!important}.gb-editor :where(label,p,span,strong,small,h1,h2,h3,h4){color:#fff!important;text-shadow:none!important}.gb-editor :where(input,select,textarea){background:#fff!important;color:#080808!important;-webkit-text-fill-color:#080808!important;opacity:1!important}.gb-fill-note{padding:8px;margin:8px 0;background:#123b28;color:#fff;border:1px solid #48b77d;border-radius:7px;font:700 12px Arial}
@media(max-width:760px){#${ID}-overlay{padding:0}#${ID}-panel{border-radius:0;min-height:100vh}.gb-grid,.gb-summary{grid-template-columns:repeat(2,minmax(130px,1fr))}}@media(max-width:420px){.gb-grid{grid-template-columns:1fr}}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function field(key, title, type = 'number') {
    const value = settings[key];
    const input = type === 'select'
      ? `<select data-setting="${key}"><option value="current" ${value === 'current' ? 'selected' : ''}>Keep current payroll</option><option value="fixed" ${value === 'fixed' ? 'selected' : ''}>Fixed total budget</option><option value="benchmark" ${value === 'benchmark' ? 'selected' : ''}>Benchmark wage × score</option></select>`
      : `<input type="number" min="0" inputmode="numeric" data-setting="${key}" value="${esc(value)}">`;
    return `<div class="gb-field"><label>${esc(title)} <button type="button" class="gb-q" data-help="${key}">?</button></label>${input}<div class="gb-help" id="${ID}-help-${key}"></div></div>`;
  }

  function render() {
    const panel = $(`#${ID}-panel`); if (!panel) return;
    let result = null; try { if (employees.length) result = calculate(); } catch (e) { error = String(e?.message || e); }
    panel.innerHTML = `
<div class="gb-head"><div><div class="gb-title">Ghost Byte Wage Calculator</div><div class="gb-sub">Advisory only — no wage or position is submitted automatically.</div></div><button class="gb-btn" data-action="close">Close</button></div>
<div class="gb-tools"><button class="gb-btn gb-primary" data-action="refresh" ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Refresh API'}</button><button class="gb-btn" data-action="settings">Settings</button><button class="gb-btn" data-action="copy" ${result ? '' : 'disabled'}>Copy wages</button></div>
<div class="gb-settings ${settingsOpen ? 'open' : ''}"><div class="gb-grid">${field('mode','Payment model','select')}${field('fixedBudget','Fixed daily payroll')}${field('benchmark','Benchmark daily wage')}${field('targetEff','Target effectiveness')}${field('statWeight','Work-stat weight')}${field('effWeight','Effectiveness weight')}${field('minWage','Minimum wage')}${field('maxWage','Maximum wage')}${field('roundTo','Round wages to')}<label class="gb-check"><input type="checkbox" data-setting="includeDirector" ${settings.includeDirector ? 'checked' : ''}> Include director <button type="button" class="gb-q" data-help="includeDirector">?</button></label><label class="gb-check"><input type="checkbox" data-setting="autoFill" ${settings.autoFill ? 'checked' : ''}> Autofill wage field <button type="button" class="gb-q" data-help="autoFill">?</button></label></div><div class="gb-note" style="margin-top:12px">Click each question mark for a brief and detailed explanation. Position suggestions are informational stat-fit estimates only.</div></div>
${error ? `<div class="gb-error">${esc(error)}</div>` : ''}${loading ? '<div class="gb-status">Loading company employees from the Torn API…</div>' : ''}
${result ? `<div class="gb-summary"><div class="gb-card"><small>Employees</small><b>${num.format(result.rows.length)}</b></div><div class="gb-card"><small>Current payroll</small><b>${cash.format(result.current)}</b></div><div class="gb-card"><small>Suggested payroll</small><b>${cash.format(result.suggested)}</b></div><div class="gb-card"><small>Median included stats</small><b>${num.format(result.med)}</b></div></div><div class="gb-wrap"><table class="gb-table"><thead><tr><th>Include</th><th>Employee</th><th>Current position</th><th>Suggested position</th><th>MAN</th><th>INT</th><th>END</th><th>Eff.</th><th>Score</th><th>Current</th><th>Suggested</th><th>Change</th></tr></thead><tbody>${result.rows.map(e => `<tr class="${e.omitted ? 'gb-omitted' : ''}"><td><input type="checkbox" data-include="${esc(e.id)}" ${excluded.has(e.id) ? '' : 'checked'}></td><td><a href="#" data-employee="${esc(e.id)}">${esc(e.name)}</a></td><td>${esc(e.position)}</td><td title="Information only">${esc(e.role)}</td><td>${num.format(e.manual)}</td><td>${num.format(e.intelligence)}</td><td>${num.format(e.endurance)}</td><td>${num.format(e.effectiveness)}</td><td>${e.omitted ? '—' : e.score.toFixed(3)}</td><td>${cash.format(e.wage)}</td><td><b>${cash.format(e.suggested)}</b></td><td class="${e.change > 0 ? 'gb-up' : e.change < 0 ? 'gb-down' : ''}">${e.change > 0 ? '+' : e.change < 0 ? '−' : ''}${cash.format(Math.abs(e.change))}</td></tr>`).join('')}</tbody></table></div>` : (!loading ? '<div class="gb-status">Tap Refresh API to load employees.</div>' : '')}`;
    bind(result);
  }

  function bind(result) {
    const panel = $(`#${ID}-panel`);
    $('[data-action="close"]', panel)?.addEventListener('click', close);
    $('[data-action="refresh"]', panel)?.addEventListener('click', refresh);
    $('[data-action="settings"]', panel)?.addEventListener('click', () => { settingsOpen = !settingsOpen; render(); });
    $('[data-action="copy"]', panel)?.addEventListener('click', () => copy(result.rows.filter(e => !e.omitted).map(e => `${e.name} [${e.id}] — ${cash.format(e.suggested)} / day`).join('\n')));
    $$('[data-setting]', panel).forEach(input => input.addEventListener('change', () => {
      settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? n(input.value) : input.value;
      save('settings', settings); render();
    }));
    $$('[data-help]', panel).forEach(button => button.addEventListener('click', ev => {
      ev.preventDefault(); const [brief, detail] = help[button.dataset.help]; const box = $(`#${ID}-help-${button.dataset.help}`, panel) || button.closest('.gb-check')?.nextElementSibling;
      let target = box; if (!target) { target = document.createElement('div'); target.className = 'gb-help'; button.closest('.gb-check')?.appendChild(target); }
      target.innerHTML = `<b>${esc(brief)}</b><br>${esc(detail)}`; target.classList.toggle('open');
    }));
    $$('[data-include]', panel).forEach(input => input.addEventListener('change', () => { input.checked ? excluded.delete(input.dataset.include) : excluded.add(input.dataset.include); save('excluded', [...excluded]); render(); }));
    $$('[data-employee]', panel).forEach(link => link.addEventListener('click', ev => { ev.preventDefault(); const row = result.rows.find(e => e.id === link.dataset.employee); if (row) chooseEmployee(row); }));
  }

  async function refresh() { loading = true; error = ''; render(); try { employees = await fetchEmployees(); } catch (e) { error = String(e?.message || e); } finally { loading = false; render(); } }
  function open() { $(`#${ID}-overlay`)?.classList.add('open'); render(); if (!employees.length && !loading) refresh(); }
  function close() { $(`#${ID}-overlay`)?.classList.remove('open'); }

  function visible(el) { if (!(el instanceof Element)) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
  function wageInput() {
    const selectors = ['input[name*="wage" i]','input[id*="wage" i]','input[placeholder*="wage" i]','input[aria-label*="wage" i]','input[name*="salary" i]','input[id*="salary" i]'];
    for (const s of selectors) { const list = $$(s).filter(visible); if (list.length) return list.at(-1); }
    const dialogs = $$('[role="dialog"],[class*="modal" i],[class*="popup" i],[class*="employee" i]').filter(visible).reverse();
    for (const d of dialogs) { if (!/wage|salary|pay/i.test(d.textContent || '')) continue; const list = $$('input[type="number"],input[inputmode="numeric"],input[type="text"]', d).filter(visible); if (list.length) return list[0]; }
    return null;
  }
  function enhanceEditor() { const input = wageInput(); if (!input) return; (input.closest('[role="dialog"],form,[class*="modal" i],[class*="popup" i],[class*="dialog" i]') || input.parentElement)?.classList.add('gb-editor'); }
  function fillSelected() {
    enhanceEditor(); if (!settings.autoFill || !selectedId) return;
    const row = latestRows.find(e => e.id === selectedId); if (!row || row.omitted) return;
    const input = wageInput(); if (!input || input.dataset.gbFilledFor === row.id) return;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); descriptor?.set?.call(input, String(Math.round(row.suggested)));
    input.dataset.gbFilledFor = row.id; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    const note = document.createElement('div'); note.className = 'gb-fill-note'; note.textContent = `Filled ${row.name}: ${cash.format(row.suggested)}. Review it, then press Update manually.`; input.insertAdjacentElement('afterend', note); input.focus();
  }
  async function chooseEmployee(row) {
    selectedId = row.id; close();
    const native = $$(`a[href*="XID=${CSS.escape(row.id)}"],a[href*="userID=${CSS.escape(row.id)}"]`).find(visible); native?.click();
    if (!settings.autoFill) return;
    for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 160)); fillSelected(); if (wageInput()?.dataset.gbFilledFor === row.id) break; }
  }
  function identifyNativeEmployee(target) {
    if (!(target instanceof Element) || !employees.length) return null;
    const link = target.closest('a[href*="profiles.php"],a[href*="XID="]');
    if (link) { try { const id = new URL(link.href, location.href).searchParams.get('XID'); const found = employees.find(e => e.id === String(id)); if (found) return found; } catch (_) {} }
    const box = target.closest('tr,li,[class*="employee" i],[data-user-id],[data-userid]') || target;
    const text = (box.textContent || '').toLowerCase(); return employees.find(e => text.includes(e.name.toLowerCase())) || null;
  }

  function drag(button) {
    const saved = load('position', {}); const place = (x, y) => { const maxX = Math.max(6, innerWidth - button.offsetWidth - 6); const maxY = Math.max(6, innerHeight - button.offsetHeight - 6); x = clamp(n(x), 6, maxX); y = clamp(n(y), 6, maxY); button.style.left = `${x}px`; button.style.top = `${y}px`; button.style.right = 'auto'; button.style.bottom = 'auto'; return { x, y }; };
    requestAnimationFrame(() => { if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y); });
    let d = null, moved = false;
    button.addEventListener('pointerdown', e => { const r = button.getBoundingClientRect(); d = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top }; moved = false; button.setPointerCapture?.(e.pointerId); });
    button.addEventListener('pointermove', e => { if (!d || d.id !== e.pointerId) return; moved = true; e.preventDefault(); place(e.clientX - d.dx, e.clientY - d.dy); });
    button.addEventListener('pointerup', e => { if (!d || d.id !== e.pointerId) return; const r = button.getBoundingClientRect(); save('position', place(r.left, r.top)); d = null; if (!moved) open(); });
    button.addEventListener('pointercancel', () => { d = null; });
    addEventListener('resize', () => { const r = button.getBoundingClientRect(); save('position', place(r.left, r.top)); });
  }

  function ensure() {
    if (!document.body) return;
    installStyles();
    if (!$(`#${ID}-button`)) { const b = document.createElement('button'); b.id = `${ID}-button`; b.type = 'button'; b.textContent = '💵 Wage Calc'; b.title = 'Tap to open · drag to move'; document.body.appendChild(b); drag(b); }
    if (!$(`#${ID}-overlay`)) { const o = document.createElement('div'); o.id = `${ID}-overlay`; o.innerHTML = `<div id="${ID}-panel"></div>`; o.addEventListener('click', e => { if (e.target === o) close(); }); document.body.appendChild(o); }
  }

  function copy(text) { if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text); else { const a = document.createElement('textarea'); a.value = text; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } }

  function start() {
    ensure();
    document.addEventListener('click', e => { const found = identifyNativeEmployee(e.target); if (found) { selectedId = found.id; if (settings.autoFill) { setTimeout(fillSelected, 100); setTimeout(fillSelected, 450); setTimeout(fillSelected, 900); } } }, true);
    new MutationObserver(() => { ensure(); enhanceEditor(); if (settings.autoFill && selectedId) setTimeout(fillSelected, 80); }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(ensure, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
