// ==UserScript==
// @name         Ghost Byte Wage Calculator
// @namespace    wyn.torn.company.tools
// @version      1.3.0
// @description  Self-contained Torn PDA company wage calculator. No secondary script downloads.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/companies.php*
// @match        https://www.torn.com/joblist.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const API_KEY = '###PDA-APIKEY###';
  const ID = 'gb-wage-calculator';
  const SETTINGS_KEY = `${ID}:settings:v3`;
  const EXCLUDED_KEY = `${ID}:excluded:v3`;
  const POSITION_KEY = `${ID}:button-position:v3`;

  const defaults = {
    mode: 'current',
    fixedBudget: 10000000,
    benchmarkWage: 1000000,
    targetEffectiveness: 100,
    statWeight: 35,
    effectivenessWeight: 65,
    minimumWage: 0,
    maximumWage: 25000000,
    roundTo: 10000,
    includeDirector: false,
    autofillWage: false,
  };

  const help = {
    mode: ['Payment model', 'Choose how the suggested payroll is created. Keep current payroll redistributes the included employees’ existing total pay. Fixed budget distributes the amount you enter. Benchmark multiplies each employee score by the benchmark wage.'],
    fixedBudget: ['Fixed daily payroll', 'Used only in Fixed budget mode. This is the total daily amount divided among included employees according to their calculated scores.'],
    benchmarkWage: ['Benchmark daily wage', 'Used only in Benchmark mode. An employee with a score of 1.00 receives approximately this amount before minimum, maximum, and rounding rules.'],
    targetEffectiveness: ['Target effectiveness', 'Effectiveness is divided by this value when calculating the performance index. At the default 100, an effectiveness of 100 produces an index of 1.00.'],
    statWeight: ['Work-stat weight', 'Controls how strongly Manual Labor, Intelligence, and Endurance influence wages. It is combined proportionally with the effectiveness weight.'],
    effectivenessWeight: ['Effectiveness weight', 'Controls how strongly current employee effectiveness influences wages. A larger value rewards present role performance more heavily.'],
    minimumWage: ['Minimum wage', 'The lowest suggested daily wage for an included employee. Excluded employees keep their current wage.'],
    maximumWage: ['Maximum wage', 'The highest suggested daily wage. The default is $25,000,000.'],
    roundTo: ['Round wages to', 'Rounds every suggested wage to this increment, such as $10,000, to make updates easier to enter.'],
    includeDirector: ['Include director', 'When off, the director is not included in score, median, or payroll distribution calculations.'],
    autofillWage: ['Autofill visible wage field', 'When enabled, tapping an employee in this calculator opens the matching employee entry when possible and fills the visible wage textbox with the suggested wage. It never presses Update or Save.'],
  };

  let settings = load(SETTINGS_KEY, defaults);
  let excluded = new Set(load(EXCLUDED_KEY, []));
  let employees = [];
  let settingsOpen = false;
  let loading = false;
  let error = '';
  let sort = { key: 'suggested', direction: -1 };

  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return Array.isArray(fallback) ? [...fallback] : fallback === null ? null : { ...fallback };
      const parsed = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : [...fallback];
      if (fallback === null) return parsed;
      return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : { ...fallback };
    } catch (_) { return Array.isArray(fallback) ? [...fallback] : fallback === null ? null : { ...fallback }; }
  }

  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function saveExcluded() { localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...excluded])); }
  function n(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function sum(list, getter) { return list.reduce((total, item) => total + n(getter(item)), 0); }
  function round(value) { return Math.round(value / Math.max(1, n(settings.roundTo))) * Math.max(1, n(settings.roundTo)); }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 1;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function normalizeCollection(collection) {
    const entries = Array.isArray(collection) ? collection.map((v, i) => [v?.id ?? v?.user_id ?? i, v]) : Object.entries(collection || {});
    return entries.map(([fallbackId, raw]) => {
      const ws = raw?.working_stats || raw?.work_stats || raw?.stats || {};
      const user = raw?.user && typeof raw.user === 'object' ? raw.user : {};
      const effSource = raw?.effectiveness ?? raw?.efficiency ?? 0;
      const position = typeof raw?.position === 'object' ? (raw.position.name || raw.position.title) : (raw?.position || raw?.role || 'Unassigned');
      const manual = n(ws.manual_labor ?? ws.manual ?? raw?.manual_labor ?? raw?.manual ?? raw?.man);
      const intelligence = n(ws.intelligence ?? ws.intel ?? raw?.intelligence ?? raw?.intel ?? raw?.int);
      const endurance = n(ws.endurance ?? ws.end ?? raw?.endurance ?? raw?.end);
      let effectiveness = n(effSource);
      if (effSource && typeof effSource === 'object') {
        effectiveness = n(effSource.total ?? effSource.overall ?? effSource.effectiveness ?? effSource.value);
        if (!effectiveness) effectiveness = Object.values(effSource).reduce((a, v) => a + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
      }
      return {
        id: String(raw?.id ?? raw?.user_id ?? raw?.player_id ?? user.id ?? fallbackId),
        name: String(raw?.name ?? raw?.username ?? user.name ?? `Employee ${fallbackId}`),
        position: String(position || 'Unassigned'),
        manual, intelligence, endurance,
        totalStats: manual + intelligence + endurance,
        effectiveness,
        current: n(raw?.wage ?? raw?.salary ?? raw?.daily_wage ?? raw?.pay),
        director: Boolean(raw?.is_director) || /director/i.test(String(position || '')),
      };
    });
  }

  async function fetchEmployees() {
    if (!API_KEY || API_KEY.includes('###PDA-APIKEY###')) throw new Error('Torn PDA did not provide an API key. Configure a Limited or Custom API key with company employee access.');
    const response = await fetch(`https://api.torn.com/v2/company/employees?key=${encodeURIComponent(API_KEY)}`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!response.ok) throw new Error(`Torn API request failed (${response.status}).`);
    const data = await response.json();
    if (data?.error) throw new Error(data.error.error || data.error.message || 'Torn API error.');
    const rows = normalizeCollection(data?.employees ?? data?.company_employees ?? data?.companyEmployees ?? []);
    if (!rows.length) throw new Error('No employees were returned. Confirm that this API key belongs to the company director.');
    return rows;
  }

  function suggestedPosition(employee) {
    const { manual: m, intelligence: i, endurance: e } = employee;
    const total = Math.max(1, m + i + e);
    const ratios = { m: m / total, i: i / total, e: e / total };
    if (i >= 3500 && e >= 7000) return 'Manager';
    if (i >= 3500 && m >= 3500) return 'Marketer';
    if (ratios.i >= .48) return 'Receptionist';
    if (ratios.e >= .48) return 'Store Assistant';
    if (ratios.m >= .48) return 'Cleaner';
    if (i + e >= m + Math.max(i, e) * .55) return 'Manager track';
    if (m + i >= e + Math.max(m, i) * .55) return 'Sales / marketing';
    return 'General staff';
  }

  function calculate() {
    const eligible = employees.filter(e => !excluded.has(e.id) && (settings.includeDirector || !e.director));
    if (!eligible.length) return { rows: employees.map(e => ({ ...e, excluded: true, suggested: e.current, delta: 0, score: 0, suggestion: suggestedPosition(e) })), currentPayroll: sum(employees, e => e.current), suggestedPayroll: sum(employees, e => e.current), medianStats: 0 };

    const med = Math.max(1, median(eligible.map(e => e.totalStats)));
    const statWeight = Math.max(0, n(settings.statWeight));
    const effWeight = Math.max(0, n(settings.effectivenessWeight));
    const weightTotal = statWeight + effWeight || 1;
    const scored = eligible.map(e => {
      const statIndex = clamp(Math.log1p(e.totalStats) / Math.log1p(med), .35, 2.25);
      const effIndex = clamp(e.effectiveness / Math.max(1, n(settings.targetEffectiveness)), 0, 2.5);
      return { ...e, score: Math.max(.01, (statIndex * statWeight + effIndex * effWeight) / weightTotal), statIndex, effIndex };
    });

    const budget = settings.mode === 'fixed' ? Math.max(0, n(settings.fixedBudget)) : sum(scored, e => e.current);
    if (settings.mode === 'benchmark') {
      scored.forEach(e => e.suggested = round(clamp(n(settings.benchmarkWage) * e.score, n(settings.minimumWage), n(settings.maximumWage))));
    } else {
      const min = Math.max(0, n(settings.minimumWage));
      const max = Math.max(min, n(settings.maximumWage));
      const baseTotal = Math.min(budget, min * scored.length);
      const remaining = Math.max(0, budget - baseTotal);
      const scoreTotal = sum(scored, e => e.score) || 1;
      scored.forEach(e => e.suggested = round(clamp((baseTotal / scored.length) + remaining * e.score / scoreTotal, min, max)));
      let diff = round(budget - sum(scored, e => e.suggested));
      const step = Math.max(1, n(settings.roundTo));
      const ordered = [...scored].sort((a, b) => diff > 0 ? b.score - a.score : a.score - b.score);
      let guard = 0;
      while (Math.abs(diff) >= step && guard++ < 500 && ordered.length) {
        const row = ordered[guard % ordered.length];
        const next = row.suggested + (diff > 0 ? step : -step);
        if (next >= min && next <= max) { row.suggested = next; diff += diff > 0 ? -step : step; }
      }
    }

    const byId = new Map(scored.map(e => [e.id, e]));
    const rows = employees.map(e => {
      const calculated = byId.get(e.id);
      const omitted = excluded.has(e.id) || (!settings.includeDirector && e.director);
      const suggested = calculated?.suggested ?? e.current;
      return { ...(calculated || e), excluded: omitted, suggested, delta: suggested - e.current, score: calculated?.score ?? 0, suggestion: suggestedPosition(e) };
    });
    return { rows, currentPayroll: sum(rows, e => e.current), suggestedPayroll: sum(rows, e => e.suggested), medianStats: med };
  }

  function styles() {
    if (document.getElementById(`${ID}-style`)) return;
    const style = document.createElement('style');
    style.id = `${ID}-style`;
    style.textContent = `
#${ID}-button{position:fixed;right:12px;bottom:80px;z-index:2147483000;border:0;border-radius:999px;padding:12px 16px;background:#176b46;color:#fff;font:700 13px Arial;box-shadow:0 4px 18px #0008;touch-action:none;user-select:none}
#${ID}-overlay{display:none;position:fixed;inset:0;z-index:2147483001;background:#000b;overflow:auto;padding:10px;box-sizing:border-box;font-family:Arial,sans-serif;color:#f4f4f4}#${ID}-overlay.open{display:block}
#${ID}-panel{max-width:1160px;margin:0 auto 40px;background:#17191c;border:1px solid #555;border-radius:12px;overflow:hidden}.gb-head{display:flex;justify-content:space-between;align-items:center;padding:14px;background:#0e1012;border-bottom:1px solid #444}.gb-title{font-size:18px;font-weight:800}.gb-sub{font-size:12px;color:#d1d1d1;margin-top:3px}.gb-tools{display:flex;flex-wrap:wrap;gap:7px;padding:11px;background:#202327;border-bottom:1px solid #444}.gb-btn{border:1px solid #666;border-radius:7px;padding:8px 10px;background:#30343a;color:#fff;font-weight:700}.gb-btn.primary{background:#176b46}.gb-btn:disabled{opacity:.5}.gb-settings{display:none;padding:12px;background:#22262a;border-bottom:1px solid #444}.gb-settings.open{display:block}.gb-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.gb-field label{display:flex;align-items:center;gap:5px;margin-bottom:5px;color:#fff;font-size:12px;font-weight:700}.gb-field input,.gb-field select{width:100%;box-sizing:border-box;background:#090a0c;color:#fff;border:1px solid #777;border-radius:6px;padding:9px;font-size:14px}.gb-help{width:20px;height:20px;padding:0;border-radius:50%;border:1px solid #aaa;background:#3b4046;color:#fff;font-weight:900}.gb-check{display:flex;align-items:center;gap:8px;margin-top:25px;color:#fff;font-size:13px}.gb-helpbox{display:none;margin-top:12px;padding:11px;background:#08090b;color:#fff;border:1px solid #777;border-radius:7px;line-height:1.45}.gb-helpbox.open{display:block}.gb-error{margin:12px;padding:10px;background:#5b1e1e;color:#fff;border:1px solid #d36b6b;border-radius:7px}.gb-summary{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:8px;padding:12px}.gb-card{background:#272b30;border:1px solid #555;border-radius:8px;padding:10px}.gb-card small{display:block;color:#ddd}.gb-card b{display:block;margin-top:4px;font-size:16px;color:#fff}.gb-wrap{overflow:auto;padding:0 12px 15px}.gb-table{width:100%;min-width:1080px;border-collapse:collapse;font-size:12px}.gb-table th{position:sticky;top:0;background:#0d0f11;color:#fff;padding:9px 7px;border-bottom:1px solid #777;white-space:nowrap}.gb-table td{padding:9px 7px;border-bottom:1px solid #45494e;color:#fff;text-align:right;white-space:nowrap}.gb-table th:nth-child(-n+4),.gb-table td:nth-child(-n+4){text-align:left}.gb-table tr:hover td{background:#30353a}.gb-name{color:#8fcaff;text-decoration:none;font-weight:800}.gb-muted{color:#c7c7c7}.gb-up{color:#7df0a8;font-weight:800}.gb-down{color:#ff9b9b;font-weight:800}.gb-excluded td{opacity:.62}.gb-status{padding:14px;color:#fff}@media(max-width:700px){#${ID}-overlay{padding:0}#${ID}-panel{border-radius:0;min-height:100vh}.gb-grid{grid-template-columns:repeat(2,minmax(130px,1fr))}.gb-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}.gb-table{font-size:13px}}
`;
    document.head.appendChild(style);
  }

  function field(key, label, type = 'number') {
    const value = settings[key];
    if (type === 'select') return `<div class="gb-field"><label>${esc(label)} <button class="gb-help" data-help="${key}">?</button></label><select data-setting="${key}"><option value="current" ${value === 'current' ? 'selected' : ''}>Keep current payroll</option><option value="fixed" ${value === 'fixed' ? 'selected' : ''}>Fixed total budget</option><option value="benchmark" ${value === 'benchmark' ? 'selected' : ''}>Benchmark wage × score</option></select></div>`;
    return `<div class="gb-field"><label>${esc(label)} <button class="gb-help" data-help="${key}">?</button></label><input type="number" min="0" step="1000" data-setting="${key}" value="${esc(value)}"></div>`;
  }

  function check(key, label) {
    return `<label class="gb-check"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}> ${esc(label)} <button class="gb-help" data-help="${key}" type="button">?</button></label>`;
  }

  function render() {
    const panel = document.getElementById(`${ID}-panel`);
    if (!panel) return;
    let result = null;
    try { if (employees.length) result = calculate(); } catch (e) { error = e.message; }
    const rows = result ? [...result.rows].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      return (typeof av === 'string' ? av.localeCompare(bv) : n(av) - n(bv)) * sort.direction;
    }) : [];

    panel.innerHTML = `<div class="gb-head"><div><div class="gb-title">Ghost Byte Wage Calculator</div><div class="gb-sub">Self-contained · advisory calculation · no automatic Update click</div></div><button class="gb-btn" data-action="close">Close</button></div>
<div class="gb-tools"><button class="gb-btn primary" data-action="refresh" ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Refresh API'}</button><button class="gb-btn" data-action="settings">Settings</button><button class="gb-btn" data-action="copy" ${result ? '' : 'disabled'}>Copy wages</button><button class="gb-btn" data-action="csv" ${result ? '' : 'disabled'}>Copy CSV</button></div>
<div class="gb-settings ${settingsOpen ? 'open' : ''}"><div class="gb-grid">${field('mode', 'Payment model', 'select')}${field('fixedBudget', 'Fixed daily payroll')}${field('benchmarkWage', 'Benchmark daily wage')}${field('targetEffectiveness', 'Target effectiveness')}${field('statWeight', 'Work-stat weight')}${field('effectivenessWeight', 'Effectiveness weight')}${field('minimumWage', 'Minimum wage')}${field('maximumWage', 'Maximum wage')}${field('roundTo', 'Round wages to')}${check('includeDirector', 'Include director')}${check('autofillWage', 'Autofill visible wage field')}</div><div class="gb-helpbox" id="${ID}-help"></div></div>
${error ? `<div class="gb-error">${esc(error)}</div>` : ''}${loading ? '<div class="gb-status">Loading company employees from the Torn API…</div>' : ''}
${result ? `<div class="gb-summary"><div class="gb-card"><small>Employees</small><b>${number.format(result.rows.length)}</b></div><div class="gb-card"><small>Current payroll</small><b>${money.format(result.currentPayroll)}</b></div><div class="gb-card"><small>Suggested payroll</small><b>${money.format(result.suggestedPayroll)}</b></div><div class="gb-card"><small>Median included stats</small><b>${number.format(result.medianStats)}</b></div></div><div class="gb-wrap"><table class="gb-table"><thead><tr>${[['excluded','Include'],['name','Employee'],['position','Current position'],['suggestion','Suggested position'],['manual','MAN'],['intelligence','INT'],['endurance','END'],['effectiveness','Eff.'],['score','Score'],['current','Current wage'],['suggested','Suggested wage'],['delta','Change']].map(([k,l]) => `<th data-sort="${k}">${l}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr class="${row.excluded ? 'gb-excluded' : ''}"><td><input type="checkbox" data-include="${esc(row.id)}" ${excluded.has(row.id) ? '' : 'checked'}></td><td><a href="#" class="gb-name" data-employee="${esc(row.id)}">${esc(row.name)}</a></td><td>${esc(row.position)}</td><td title="Informational stat fit only">${esc(row.suggestion)}</td><td>${number.format(row.manual)}</td><td>${number.format(row.intelligence)}</td><td>${number.format(row.endurance)}</td><td>${number.format(row.effectiveness)}</td><td>${row.excluded ? '—' : row.score.toFixed(3)}</td><td>${money.format(row.current)}</td><td><b>${money.format(row.suggested)}</b></td><td class="${row.delta > 0 ? 'gb-up' : row.delta < 0 ? 'gb-down' : 'gb-muted'}">${row.delta > 0 ? '+' : row.delta < 0 ? '−' : ''}${money.format(Math.abs(row.delta))}</td></tr>`).join('')}</tbody></table></div>` : (!loading ? '<div class="gb-status">Tap Refresh API to load your employees.</div>' : '')}`;

    bind(result);
  }

  function bind(result) {
    const panel = document.getElementById(`${ID}-panel`);
    panel.querySelector('[data-action="close"]')?.addEventListener('click', closePanel);
    panel.querySelector('[data-action="refresh"]')?.addEventListener('click', refresh);
    panel.querySelector('[data-action="settings"]')?.addEventListener('click', () => { settingsOpen = !settingsOpen; render(); });
    panel.querySelector('[data-action="copy"]')?.addEventListener('click', () => copy(result.rows.filter(r => !r.excluded).map(r => `${r.name} [${r.id}] — ${money.format(r.suggested)} / day`).join('\n')));
    panel.querySelector('[data-action="csv"]')?.addEventListener('click', () => copy(['ID,Name,Included,Current Position,Suggested Position,MAN,INT,END,Effectiveness,Score,Current Wage,Suggested Wage', ...result.rows.map(r => [r.id, csv(r.name), !r.excluded, csv(r.position), csv(r.suggestion), r.manual, r.intelligence, r.endurance, r.effectiveness, r.score.toFixed(3), r.current, r.suggested].join(','))].join('\n')));
    panel.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('change', () => {
      const key = input.dataset.setting;
      settings[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? n(input.value) : input.value;
      saveSettings(); render();
    }));
    panel.querySelectorAll('[data-help]').forEach(button => button.addEventListener('click', e => {
      e.preventDefault(); const item = help[button.dataset.help]; const box = document.getElementById(`${ID}-help`);
      box.innerHTML = `<b>${esc(item[0])}</b><br>${esc(item[1])}`; box.classList.add('open');
    }));
    panel.querySelectorAll('[data-include]').forEach(input => input.addEventListener('change', () => {
      input.checked ? excluded.delete(input.dataset.include) : excluded.add(input.dataset.include); saveExcluded(); render();
    }));
    panel.querySelectorAll('[data-sort]').forEach(header => header.addEventListener('click', () => {
      sort = sort.key === header.dataset.sort ? { key: sort.key, direction: -sort.direction } : { key: header.dataset.sort, direction: ['name','position','suggestion'].includes(header.dataset.sort) ? 1 : -1 }; render();
    }));
    panel.querySelectorAll('[data-employee]').forEach(link => link.addEventListener('click', e => {
      e.preventDefault(); const row = result.rows.find(r => r.id === link.dataset.employee); if (row) selectEmployee(row);
    }));
  }

  function csv(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch (_) { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); toast('Copied.'); } }
  function toast(text) { const div = document.createElement('div'); div.textContent = text; div.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;border:1px solid #777;border-radius:8px;padding:9px 13px;font:700 12px Arial'; document.body.appendChild(div); setTimeout(() => div.remove(), 1800); }

  async function selectEmployee(row) {
    closePanel();
    const nativeLink = [...document.querySelectorAll(`a[href*="XID=${row.id}"],a[href*="userID=${row.id}"]`)].find(el => el.offsetParent !== null);
    nativeLink?.click();
    if (!settings.autofillWage) return;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 160));
      const candidates = [...document.querySelectorAll('input[name*="wage" i],input[name*="salary" i],input[id*="wage" i],input[id*="salary" i],input[type="number"]')].filter(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
      const input = candidates.find(el => el.closest('[class*="employee" i],[class*="modal" i],[class*="dialog" i],[class*="details" i]')) || candidates[0];
      if (input) { input.focus(); input.value = String(Math.round(row.suggested)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); toast(`Filled ${row.name}'s wage. Review it, then tap Update manually.`); return; }
    }
    toast('Employee wage field was not found. Open the employee editor and tap the employee again.');
  }

  async function refresh() {
    loading = true; error = ''; render();
    try { employees = await fetchEmployees(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { loading = false; render(); }
  }

  function openPanel() { document.getElementById(`${ID}-overlay`)?.classList.add('open'); render(); if (!employees.length && !loading) refresh(); }
  function closePanel() { document.getElementById(`${ID}-overlay`)?.classList.remove('open'); }

  function movable(button) {
    const stored = load(POSITION_KEY, null);
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) { button.style.left = `${stored.x}px`; button.style.top = `${stored.y}px`; button.style.right = 'auto'; button.style.bottom = 'auto'; }
    let dragging = false, moved = false, dx = 0, dy = 0;
    button.addEventListener('pointerdown', e => { dragging = true; moved = false; const rect = button.getBoundingClientRect(); dx = e.clientX - rect.left; dy = e.clientY - rect.top; button.setPointerCapture(e.pointerId); });
    button.addEventListener('pointermove', e => { if (!dragging) return; moved = true; const x = clamp(e.clientX - dx, 0, innerWidth - button.offsetWidth); const y = clamp(e.clientY - dy, 0, innerHeight - button.offsetHeight); button.style.left = `${x}px`; button.style.top = `${y}px`; button.style.right = 'auto'; button.style.bottom = 'auto'; });
    button.addEventListener('pointerup', e => { if (!dragging) return; dragging = false; button.releasePointerCapture(e.pointerId); const rect = button.getBoundingClientRect(); localStorage.setItem(POSITION_KEY, JSON.stringify({ x: rect.left, y: rect.top })); if (!moved) openPanel(); });
    addEventListener('resize', () => { const rect = button.getBoundingClientRect(); button.style.left = `${clamp(rect.left, 0, innerWidth - button.offsetWidth)}px`; button.style.top = `${clamp(rect.top, 0, innerHeight - button.offsetHeight)}px`; });
  }

  function install() {
    styles();
    if (!document.getElementById(`${ID}-button`)) { const button = document.createElement('button'); button.id = `${ID}-button`; button.textContent = '💵 Wage Calc'; document.body.appendChild(button); movable(button); }
    if (!document.getElementById(`${ID}-overlay`)) { const overlay = document.createElement('div'); overlay.id = `${ID}-overlay`; overlay.innerHTML = `<div id="${ID}-panel"></div>`; overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); }); document.body.appendChild(overlay); }
  }

  install();
  new MutationObserver(() => { if (document.body && !document.getElementById(`${ID}-button`)) install(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
