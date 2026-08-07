// ==UserScript==
// @name         Ghost Byte Wage Calculator
// @namespace    wyn.torn.company.tools
// @version      1.4.1
// @description  Self-contained Torn PDA wage calculator for company employees.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var ID = 'ghost-byte-wage-calculator';
  var API_KEY = '###PDA-APIKEY###';
  var STORE_PREFIX = ID + ':v141:';
  var employees = [];
  var latestRows = [];
  var excluded = loadJson('excluded', []);
  var settingsOpen = false;
  var loading = false;
  var errorMessage = '';
  var selectedEmployeeId = '';

  if (!Array.isArray(excluded)) excluded = [];

  var defaults = {
    mode: 'current',
    fixedBudget: 10000000,
    benchmarkWage: 1000000,
    targetEffectiveness: 100,
    statWeight: 35,
    effectivenessWeight: 65,
    minimumWage: 0,
    maximumWage: 25000000,
    roundTo: 10000,
    includeDirector: true,
    autofillWage: false
  };

  var settings = loadJson('settings', defaults);
  var key;
  for (key in defaults) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) settings[key] = defaults[key];
  }

  var HELP = {
    mode: {
      brief: 'Payment model',
      detail: 'Keep current payroll redistributes the included employees existing total wage. Fixed budget distributes the amount entered below. Benchmark wage multiplies each employee score by the benchmark amount.'
    },
    fixedBudget: {
      brief: 'Fixed daily payroll',
      detail: 'Used only in Fixed budget mode. This is the total daily amount divided among included employees according to their calculated scores.'
    },
    benchmarkWage: {
      brief: 'Benchmark daily wage',
      detail: 'Used only in Benchmark mode. An employee with a score of 1.00 receives approximately this wage before minimum, maximum, and rounding rules.'
    },
    targetEffectiveness: {
      brief: 'Target effectiveness',
      detail: 'Effectiveness is divided by this value. With the default of 100, an effectiveness of 100 produces an effectiveness index of 1.00.'
    },
    statWeight: {
      brief: 'Work-stat weight',
      detail: 'Controls how strongly Manual Labor, Intelligence, and Endurance influence the wage score. It is combined proportionally with the effectiveness weight.'
    },
    effectivenessWeight: {
      brief: 'Effectiveness weight',
      detail: 'Controls how strongly current employee effectiveness influences the wage score. A larger value rewards current role performance more heavily.'
    },
    minimumWage: {
      brief: 'Minimum wage',
      detail: 'The lowest suggested daily wage for an included employee. Excluded employees keep their existing wage.'
    },
    maximumWage: {
      brief: 'Maximum wage',
      detail: 'The highest suggested daily wage. The default is 25,000,000.'
    },
    roundTo: {
      brief: 'Round wages to',
      detail: 'Rounds every suggested wage to this increment. For example, 10000 rounds recommendations to the nearest 10,000.'
    },
    includeDirector: {
      brief: 'Include director',
      detail: 'When disabled, the director remains visible but is excluded from the median, score, and wage distribution calculations.'
    },
    autofillWage: {
      brief: 'Autofill visible wage field',
      detail: 'When enabled, selecting an employee attempts to open the employee editor and fills the visible wage textbox. The script never presses Update, Save, or Submit.'
    }
  };

  var ROLE_RULES = [
    { name: 'Lead Developer', primary: 'endurance', primaryRequired: 48000, secondary: 'intelligence', secondaryRequired: 24000 },
    { name: 'Analyst', primary: 'endurance', primaryRequired: 36000, secondary: 'intelligence', secondaryRequired: 18000 },
    { name: 'Developer', primary: 'intelligence', primaryRequired: 24000, secondary: 'endurance', secondaryRequired: 12000 },
    { name: 'Graphic Designer', primary: 'intelligence', primaryRequired: 18000, secondary: 'endurance', secondaryRequired: 9000 },
    { name: 'Tester', primary: 'intelligence', primaryRequired: 12000, secondary: 'endurance', secondaryRequired: 6000 },
    { name: 'Cleaner', primary: 'manual', primaryRequired: 12000, secondary: 'endurance', secondaryRequired: 6000 },
    { name: 'Apprentice', primary: 'intelligence', primaryRequired: 6000, secondary: 'endurance', secondaryRequired: 3000 }
  ];

  function q(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function loadJson(name, fallback) {
    try {
      var raw = localStorage.getItem(STORE_PREFIX + name);
      if (!raw) return cloneFallback(fallback);
      var parsed = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : cloneFallback(fallback);
      return parsed && typeof parsed === 'object' ? parsed : cloneFallback(fallback);
    } catch (e) {
      return cloneFallback(fallback);
    }
  }

  function cloneFallback(value) {
    if (Array.isArray(value)) return value.slice();
    var output = {};
    var k;
    for (k in value) output[k] = value[k];
    return output;
  }

  function saveJson(name, value) {
    try {
      localStorage.setItem(STORE_PREFIX + name, JSON.stringify(value));
    } catch (e) {
    }
  }

  function numberValue(value) {
    var result = Number(value);
    return isFinite(result) ? result : 0;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function formatNumber(value) {
    try {
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(numberValue(value));
    } catch (e) {
      return String(Math.round(numberValue(value)));
    }
  }

  function formatMoney(value) {
    return '$' + formatNumber(value);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character];
    });
  }

  function sum(list, getter) {
    var total = 0;
    var i;
    for (i = 0; i < list.length; i += 1) total += numberValue(getter(list[i]));
    return total;
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    if (!sorted.length) return 1;
    var middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function isExcluded(id) {
    return excluded.indexOf(String(id)) !== -1;
  }

  function setExcluded(id, shouldExclude) {
    id = String(id);
    var index = excluded.indexOf(id);
    if (shouldExclude && index === -1) excluded.push(id);
    if (!shouldExclude && index !== -1) excluded.splice(index, 1);
    saveJson('excluded', excluded);
  }

  function normalizeEmployees(collection) {
    var pairs = [];
    var id;
    var i;

    if (Array.isArray(collection)) {
      for (i = 0; i < collection.length; i += 1) {
        pairs.push([collection[i] && (collection[i].id || collection[i].user_id) || i, collection[i] || {}]);
      }
    } else if (collection && typeof collection === 'object') {
      for (id in collection) {
        if (Object.prototype.hasOwnProperty.call(collection, id)) pairs.push([id, collection[id] || {}]);
      }
    }

    return pairs.map(function (pair) {
      var fallbackId = pair[0];
      var raw = pair[1] || {};
      var stats = raw.working_stats || raw.work_stats || raw.stats || {};
      var user = raw.user && typeof raw.user === 'object' ? raw.user : {};
      var position = raw.position;
      var effectivenessSource = raw.effectiveness != null ? raw.effectiveness : raw.efficiency;
      var effectiveness = numberValue(effectivenessSource);

      if (position && typeof position === 'object') position = position.name || position.title;
      if (!position) position = raw.role || 'Unassigned';

      if (effectivenessSource && typeof effectivenessSource === 'object') {
        effectiveness = numberValue(effectivenessSource.total || effectivenessSource.overall || effectivenessSource.effectiveness || effectivenessSource.value);
        if (!effectiveness) {
          effectiveness = sum(Object.keys(effectivenessSource), function (k) { return effectivenessSource[k]; });
        }
      }

      var manual = numberValue(stats.manual_labor != null ? stats.manual_labor : stats.manual != null ? stats.manual : raw.manual_labor != null ? raw.manual_labor : raw.manual != null ? raw.manual : raw.man);
      var intelligence = numberValue(stats.intelligence != null ? stats.intelligence : stats.intel != null ? stats.intel : raw.intelligence != null ? raw.intelligence : raw.intel != null ? raw.intel : raw.int);
      var endurance = numberValue(stats.endurance != null ? stats.endurance : stats.end != null ? stats.end : raw.endurance != null ? raw.endurance : raw.end);

      return {
        id: String(raw.id || raw.user_id || raw.player_id || user.id || fallbackId),
        name: String(raw.name || raw.username || user.name || ('Employee ' + fallbackId)),
        position: String(position),
        manual: manual,
        intelligence: intelligence,
        endurance: endurance,
        totalStats: manual + intelligence + endurance,
        effectiveness: effectiveness,
        currentWage: numberValue(raw.wage != null ? raw.wage : raw.salary != null ? raw.salary : raw.daily_wage != null ? raw.daily_wage : raw.pay),
        director: Boolean(raw.is_director) || /director/i.test(String(position))
      };
    });
  }

  function fetchEmployees() {
    return new Promise(function (resolve, reject) {
      if (!API_KEY || API_KEY.indexOf('###PDA-APIKEY###') !== -1) {
        reject(new Error('Torn PDA did not supply an API key. Configure an API key with company employee access.'));
        return;
      }

      var url = 'https://api.torn.com/v2/company/employees?key=' + encodeURIComponent(API_KEY);
      fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('Torn API request failed (' + response.status + ').');
          return response.json();
        })
        .then(function (data) {
          if (data && data.error) throw new Error(data.error.error || data.error.message || 'Torn API error.');
          var rows = normalizeEmployees(data && (data.employees || data.company_employees || data.companyEmployees) || []);
          if (!rows.length) throw new Error('No employees were returned. Confirm the API key belongs to the company director.');
          resolve(rows);
        })
        .catch(reject);
    });
  }

  function suggestedPosition(employee) {
    var best = null;
    var i;

    for (i = 0; i < ROLE_RULES.length; i += 1) {
      var rule = ROLE_RULES[i];
      var primaryRatio = numberValue(employee[rule.primary]) / rule.primaryRequired;
      var secondaryRatio = numberValue(employee[rule.secondary]) / rule.secondaryRequired;
      var qualified = Math.min(primaryRatio, secondaryRatio) >= 1;
      var score = Math.min(primaryRatio, 2) * 0.7 + Math.min(secondaryRatio, 2) * 0.3 + (qualified ? 10 : 0);
      if (!best || score > best.score) best = { name: rule.name, score: score, qualified: qualified };
    }

    if (!best) return 'General staff';
    return best.name + (best.qualified ? '' : ' (developing)');
  }

  function calculateRows() {
    var eligible = employees.filter(function (employee) {
      return !isExcluded(employee.id) && (settings.includeDirector || !employee.director);
    });

    var statMedian = Math.max(1, median(eligible.map(function (employee) { return employee.totalStats; })));
    var statWeight = Math.max(0, numberValue(settings.statWeight));
    var effectivenessWeight = Math.max(0, numberValue(settings.effectivenessWeight));
    var combinedWeight = statWeight + effectivenessWeight || 1;

    var scored = eligible.map(function (employee) {
      var statIndex = clamp(Math.log(1 + employee.totalStats) / Math.log(1 + statMedian), 0.35, 2.25);
      var effectivenessIndex = clamp(employee.effectiveness / Math.max(1, numberValue(settings.targetEffectiveness)), 0, 2.5);
      var score = Math.max(0.01, (statIndex * statWeight + effectivenessIndex * effectivenessWeight) / combinedWeight);
      var copy = {};
      var k;
      for (k in employee) copy[k] = employee[k];
      copy.score = score;
      return copy;
    });

    var minimum = Math.max(0, numberValue(settings.minimumWage));
    var maximum = Math.max(minimum, numberValue(settings.maximumWage));
    var rounding = Math.max(1, numberValue(settings.roundTo));
    var totalScore = sum(scored, function (employee) { return employee.score; }) || 1;
    var budget;

    if (settings.mode === 'benchmark') {
      scored.forEach(function (employee) {
        employee.suggestedWage = Math.round(clamp(numberValue(settings.benchmarkWage) * employee.score, minimum, maximum) / rounding) * rounding;
      });
    } else {
      budget = settings.mode === 'fixed' ? Math.max(0, numberValue(settings.fixedBudget)) : sum(scored, function (employee) { return employee.currentWage; });
      var guaranteed = Math.min(budget, minimum * scored.length);
      var remaining = Math.max(0, budget - guaranteed);

      scored.forEach(function (employee) {
        var raw = (scored.length ? guaranteed / scored.length : 0) + remaining * employee.score / totalScore;
        employee.suggestedWage = Math.round(clamp(raw, minimum, maximum) / rounding) * rounding;
      });
    }

    var byId = {};
    scored.forEach(function (employee) { byId[employee.id] = employee; });

    latestRows = employees.map(function (employee) {
      var scoredEmployee = byId[employee.id];
      var omitted = isExcluded(employee.id) || (!settings.includeDirector && employee.director);
      var suggested = scoredEmployee ? scoredEmployee.suggestedWage : employee.currentWage;
      var output = {};
      var k;
      for (k in (scoredEmployee || employee)) output[k] = (scoredEmployee || employee)[k];
      output.omitted = omitted;
      output.suggestedWage = suggested;
      output.change = suggested - employee.currentWage;
      output.positionSuggestion = suggestedPosition(employee);
      output.score = scoredEmployee ? scoredEmployee.score : 0;
      return output;
    });

    return {
      rows: latestRows,
      currentPayroll: sum(latestRows, function (employee) { return employee.currentWage; }),
      suggestedPayroll: sum(latestRows, function (employee) { return employee.suggestedWage; }),
      statMedian: eligible.length ? statMedian : 0
    };
  }

  function installStyles() {
    if (q('#' + ID + '-style')) return;
    var style = document.createElement('style');
    style.id = ID + '-style';
    style.textContent = [
      '#' + ID + '-button{position:fixed!important;right:14px;bottom:100px;left:auto;top:auto;z-index:2147483646!important;display:block!important;visibility:visible!important;opacity:1!important;border:2px solid #9af0bf;border-radius:999px;padding:12px 16px;background:#075c3a;color:#fff;font:800 14px Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.75);touch-action:none;user-select:none;-webkit-user-select:none}',
      '#' + ID + '-overlay{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.82);overflow:auto;padding:10px;box-sizing:border-box;font-family:Arial,sans-serif;color:#fff}',
      '#' + ID + '-overlay.gb-open{display:block}',
      '#' + ID + '-panel{max-width:1150px;margin:0 auto 40px;background:#15191d;border:1px solid #69737d;border-radius:12px;overflow:hidden}',
      '.gb-head{display:flex;justify-content:space-between;align-items:center;padding:14px;background:#080a0c;border-bottom:1px solid #555}',
      '.gb-title{font-size:18px;font-weight:800}.gb-sub,.gb-note{color:#e2e6e9;font-size:12px}',
      '.gb-tools{display:flex;flex-wrap:wrap;gap:7px;padding:11px;background:#22272c}',
      '.gb-btn{border:1px solid #7e8993;border-radius:7px;padding:9px 11px;background:#343b42;color:#fff;font-weight:800}.gb-primary{background:#086642}',
      '.gb-settings{display:none;padding:12px;background:#1d2227}.gb-settings.gb-open{display:block}',
      '.gb-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}',
      '.gb-field label{display:flex;align-items:center;gap:5px;color:#fff;font-size:12px;font-weight:800;margin-bottom:5px}',
      '.gb-field input,.gb-field select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #8a949e;border-radius:7px;background:#050607;color:#fff;font-size:14px}',
      '.gb-q{width:20px;height:20px;padding:0;border:1px solid #aeb7c0;border-radius:50%;background:#48515a;color:#fff;font-weight:900}',
      '.gb-help{display:none;margin-top:6px;padding:8px;border:1px solid #6d7882;border-radius:7px;background:#07090b;color:#fff;font-size:12px;line-height:1.45}.gb-help.gb-open{display:block}',
      '.gb-check{display:flex;align-items:center;gap:7px;padding-top:23px;color:#fff;font-size:13px}',
      '.gb-error{margin:12px;padding:10px;background:#5c1e1e;border:1px solid #e17d7d;border-radius:7px}.gb-status{padding:14px}',
      '.gb-summary{display:grid;grid-template-columns:repeat(4,minmax(135px,1fr));gap:8px;padding:12px}',
      '.gb-card{padding:10px;background:#272d33;border:1px solid #606b75;border-radius:8px}.gb-card small{display:block;color:#e1e5e8}.gb-card b{display:block;margin-top:4px;color:#fff;font-size:16px}',
      '.gb-wrap{overflow:auto;padding:0 12px 15px}.gb-table{width:100%;min-width:1120px;border-collapse:collapse;font-size:12px}',
      '.gb-table th{position:sticky;top:0;background:#07090b;color:#fff;padding:9px 7px;border-bottom:1px solid #777;white-space:nowrap}',
      '.gb-table td{padding:9px 7px;background:#171c21;color:#fff;border-bottom:1px solid #444;text-align:right;white-space:nowrap}.gb-table tr:nth-child(even) td{background:#101418}',
      '.gb-table th:nth-child(-n+4),.gb-table td:nth-child(-n+4){text-align:left}.gb-table a{color:#8bd1ff!important;font-weight:800}.gb-omitted td{opacity:.65}.gb-up{color:#8af0b1!important}.gb-down{color:#ff9b9b!important}',
      '.gb-editor-readable{background:#15191d!important;color:#fff!important}.gb-editor-readable label,.gb-editor-readable p,.gb-editor-readable span,.gb-editor-readable strong,.gb-editor-readable small,.gb-editor-readable h1,.gb-editor-readable h2,.gb-editor-readable h3{color:#fff!important;text-shadow:none!important}',
      '.gb-editor-readable input,.gb-editor-readable select,.gb-editor-readable textarea{background:#fff!important;color:#080808!important;-webkit-text-fill-color:#080808!important;opacity:1!important}',
      '.gb-fill-note{padding:8px;margin:8px 0;background:#123b28;color:#fff;border:1px solid #48b77d;border-radius:7px;font:700 12px Arial}',
      '@media(max-width:760px){#' + ID + '-overlay{padding:0}#' + ID + '-panel{border-radius:0;min-height:100vh}.gb-grid,.gb-summary{grid-template-columns:repeat(2,minmax(130px,1fr))}}',
      '@media(max-width:420px){.gb-grid{grid-template-columns:1fr}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function createField(name, title, type) {
    var input;
    if (type === 'select') {
      input = '<select data-setting="' + name + '">' +
        '<option value="current"' + (settings[name] === 'current' ? ' selected' : '') + '>Keep current payroll</option>' +
        '<option value="fixed"' + (settings[name] === 'fixed' ? ' selected' : '') + '>Fixed total budget</option>' +
        '<option value="benchmark"' + (settings[name] === 'benchmark' ? ' selected' : '') + '>Benchmark wage x score</option>' +
        '</select>';
    } else {
      input = '<input type="number" min="0" inputmode="numeric" data-setting="' + name + '" value="' + escapeHtml(settings[name]) + '">';
    }
    return '<div class="gb-field"><label>' + escapeHtml(title) + ' <button type="button" class="gb-q" data-help="' + name + '">?</button></label>' + input + '<div class="gb-help" id="' + ID + '-help-' + name + '"></div></div>';
  }

  function render() {
    var panel = q('#' + ID + '-panel');
    if (!panel) return;

    var result = null;
    if (employees.length) {
      try {
        result = calculateRows();
      } catch (e) {
        errorMessage = e && e.message ? e.message : String(e);
      }
    }

    var html = '';
    html += '<div class="gb-head"><div><div class="gb-title">Ghost Byte Wage Calculator</div><div class="gb-sub">Advisory only. The script never submits a wage or position.</div></div><button type="button" class="gb-btn" data-action="close">Close</button></div>';
    html += '<div class="gb-tools"><button type="button" class="gb-btn gb-primary" data-action="refresh"' + (loading ? ' disabled' : '') + '>' + (loading ? 'Loading...' : 'Refresh API') + '</button><button type="button" class="gb-btn" data-action="settings">Settings</button><button type="button" class="gb-btn" data-action="copy"' + (result ? '' : ' disabled') + '>Copy wages</button></div>';
    html += '<div class="gb-settings' + (settingsOpen ? ' gb-open' : '') + '"><div class="gb-grid">';
    html += createField('mode', 'Payment model', 'select');
    html += createField('fixedBudget', 'Fixed daily payroll');
    html += createField('benchmarkWage', 'Benchmark daily wage');
    html += createField('targetEffectiveness', 'Target effectiveness');
    html += createField('statWeight', 'Work-stat weight');
    html += createField('effectivenessWeight', 'Effectiveness weight');
    html += createField('minimumWage', 'Minimum wage');
    html += createField('maximumWage', 'Maximum wage');
    html += createField('roundTo', 'Round wages to');
    html += '<label class="gb-check"><input type="checkbox" data-setting="includeDirector"' + (settings.includeDirector ? ' checked' : '') + '> Include director <button type="button" class="gb-q" data-help="includeDirector">?</button></label>';
    html += '<label class="gb-check"><input type="checkbox" data-setting="autofillWage"' + (settings.autofillWage ? ' checked' : '') + '> Autofill wage field <button type="button" class="gb-q" data-help="autofillWage">?</button></label>';
    html += '</div><div class="gb-note" style="margin-top:12px">Click a question mark for a brief and detailed explanation. Suggested positions are informational stat-fit estimates only.</div></div>';

    if (errorMessage) html += '<div class="gb-error">' + escapeHtml(errorMessage) + '</div>';
    if (loading) html += '<div class="gb-status">Loading company employees from the Torn API...</div>';

    if (result) {
      html += '<div class="gb-summary">' +
        '<div class="gb-card"><small>Employees</small><b>' + formatNumber(result.rows.length) + '</b></div>' +
        '<div class="gb-card"><small>Current payroll</small><b>' + formatMoney(result.currentPayroll) + '</b></div>' +
        '<div class="gb-card"><small>Suggested payroll</small><b>' + formatMoney(result.suggestedPayroll) + '</b></div>' +
        '<div class="gb-card"><small>Median included stats</small><b>' + formatNumber(result.statMedian) + '</b></div>' +
        '</div>';
      html += '<div class="gb-wrap"><table class="gb-table"><thead><tr><th>Include</th><th>Employee</th><th>Current position</th><th>Suggested position</th><th>MAN</th><th>INT</th><th>END</th><th>Eff.</th><th>Score</th><th>Current wage</th><th>Suggested wage</th><th>Change</th></tr></thead><tbody>';

      result.rows.forEach(function (employee) {
        html += '<tr class="' + (employee.omitted ? 'gb-omitted' : '') + '">' +
          '<td><input type="checkbox" data-include="' + escapeHtml(employee.id) + '"' + (isExcluded(employee.id) ? '' : ' checked') + '></td>' +
          '<td><a href="#" data-employee="' + escapeHtml(employee.id) + '">' + escapeHtml(employee.name) + '</a></td>' +
          '<td>' + escapeHtml(employee.position) + '</td>' +
          '<td title="Information only">' + escapeHtml(employee.positionSuggestion) + '</td>' +
          '<td>' + formatNumber(employee.manual) + '</td>' +
          '<td>' + formatNumber(employee.intelligence) + '</td>' +
          '<td>' + formatNumber(employee.endurance) + '</td>' +
          '<td>' + formatNumber(employee.effectiveness) + '</td>' +
          '<td>' + (employee.omitted ? '-' : employee.score.toFixed(3)) + '</td>' +
          '<td>' + formatMoney(employee.currentWage) + '</td>' +
          '<td><b>' + formatMoney(employee.suggestedWage) + '</b></td>' +
          '<td class="' + (employee.change > 0 ? 'gb-up' : employee.change < 0 ? 'gb-down' : '') + '">' + (employee.change > 0 ? '+' : '') + formatMoney(employee.change) + '</td>' +
          '</tr>';
      });

      html += '</tbody></table></div>';
    } else if (!loading) {
      html += '<div class="gb-status">Tap Refresh API to load employees.</div>';
    }

    panel.innerHTML = html;
    bindPanel(result);
  }

  function bindPanel(result) {
    var panel = q('#' + ID + '-panel');
    if (!panel) return;

    var closeButton = q('[data-action="close"]', panel);
    var refreshButton = q('[data-action="refresh"]', panel);
    var settingsButton = q('[data-action="settings"]', panel);
    var copyButton = q('[data-action="copy"]', panel);

    if (closeButton) closeButton.addEventListener('click', closePanel);
    if (refreshButton) refreshButton.addEventListener('click', refreshEmployees);
    if (settingsButton) settingsButton.addEventListener('click', function () { settingsOpen = !settingsOpen; render(); });
    if (copyButton && result) copyButton.addEventListener('click', function () {
      var text = result.rows.filter(function (row) { return !row.omitted; }).map(function (row) {
        return row.name + ' [' + row.id + '] - ' + formatMoney(row.suggestedWage) + ' per day';
      }).join('\n');
      copyText(text);
    });

    qa('[data-setting]', panel).forEach(function (input) {
      input.addEventListener('change', function () {
        var name = input.getAttribute('data-setting');
        settings[name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? numberValue(input.value) : input.value;
        saveJson('settings', settings);
        render();
      });
    });

    qa('[data-help]', panel).forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        var name = button.getAttribute('data-help');
        var item = HELP[name];
        if (!item) return;
        var box = q('#' + ID + '-help-' + name, panel);
        if (!box) {
          box = document.createElement('div');
          box.className = 'gb-help';
          button.parentNode.appendChild(box);
        }
        box.innerHTML = '<b>' + escapeHtml(item.brief) + '</b><br>' + escapeHtml(item.detail);
        if (box.classList.contains('gb-open')) box.classList.remove('gb-open');
        else box.classList.add('gb-open');
      });
    });

    qa('[data-include]', panel).forEach(function (input) {
      input.addEventListener('change', function () {
        setExcluded(input.getAttribute('data-include'), !input.checked);
        render();
      });
    });

    qa('[data-employee]', panel).forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        var id = link.getAttribute('data-employee');
        var row = null;
        var i;
        for (i = 0; i < latestRows.length; i += 1) if (latestRows[i].id === id) row = latestRows[i];
        if (row) chooseEmployee(row);
      });
    });
  }

  function refreshEmployees() {
    loading = true;
    errorMessage = '';
    render();
    fetchEmployees().then(function (rows) {
      employees = rows;
    }).catch(function (error) {
      errorMessage = error && error.message ? error.message : String(error);
    }).then(function () {
      loading = false;
      render();
    });
  }

  function openPanel() {
    var overlay = q('#' + ID + '-overlay');
    if (!overlay) return;
    overlay.classList.add('gb-open');
    render();
    if (!employees.length && !loading) refreshEmployees();
  }

  function closePanel() {
    var overlay = q('#' + ID + '-overlay');
    if (overlay) overlay.classList.remove('gb-open');
  }

  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findWageInput() {
    var selectors = [
      'input[name*="wage" i]',
      'input[id*="wage" i]',
      'input[placeholder*="wage" i]',
      'input[aria-label*="wage" i]',
      'input[name*="salary" i]',
      'input[id*="salary" i]'
    ];
    var i;
    var list;
    for (i = 0; i < selectors.length; i += 1) {
      list = qa(selectors[i]).filter(isVisible);
      if (list.length) return list[list.length - 1];
    }
    return null;
  }

  function improveEditorReadability() {
    var input = findWageInput();
    if (!input) return;
    var container = input.closest('[role="dialog"],form,[class*="modal" i],[class*="popup" i],[class*="dialog" i],[class*="employee" i]') || input.parentElement;
    if (container) container.classList.add('gb-editor-readable');
  }

  function fillSelectedWage() {
    improveEditorReadability();
    if (!settings.autofillWage || !selectedEmployeeId) return false;
    var row = null;
    var i;
    for (i = 0; i < latestRows.length; i += 1) if (latestRows[i].id === selectedEmployeeId) row = latestRows[i];
    if (!row || row.omitted) return false;

    var input = findWageInput();
    if (!input || input.getAttribute('data-gb-filled-for') === row.id) return false;

    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, String(Math.round(row.suggestedWage)));
    else input.value = String(Math.round(row.suggestedWage));

    input.setAttribute('data-gb-filled-for', row.id);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();

    var note = document.createElement('div');
    note.className = 'gb-fill-note';
    note.textContent = 'Filled ' + row.name + ': ' + formatMoney(row.suggestedWage) + '. Review it, then press Update manually.';
    input.insertAdjacentElement('afterend', note);
    return true;
  }

  function chooseEmployee(row) {
    selectedEmployeeId = row.id;
    closePanel();

    var links = qa('a[href*="XID=' + row.id + '"],a[href*="userID=' + row.id + '"]');
    var visibleLink = null;
    var i;
    for (i = 0; i < links.length; i += 1) if (isVisible(links[i])) visibleLink = links[i];
    if (visibleLink) visibleLink.click();

    if (!settings.autofillWage) return;
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (fillSelectedWage() || attempts >= 30) clearInterval(timer);
    }, 160);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  function makeDraggable(button) {
    var saved = loadJson('position', {});
    var dragState = null;
    var moved = false;

    function place(x, y) {
      var maxX = Math.max(6, window.innerWidth - button.offsetWidth - 6);
      var maxY = Math.max(6, window.innerHeight - button.offsetHeight - 6);
      x = clamp(numberValue(x), 6, maxX);
      y = clamp(numberValue(y), 6, maxY);
      button.style.left = x + 'px';
      button.style.top = y + 'px';
      button.style.right = 'auto';
      button.style.bottom = 'auto';
      return { x: x, y: y };
    }

    requestAnimationFrame(function () {
      if (saved && isFinite(saved.x) && isFinite(saved.y)) place(saved.x, saved.y);
    });

    button.addEventListener('pointerdown', function (event) {
      var rect = button.getBoundingClientRect();
      dragState = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      moved = false;
      if (button.setPointerCapture) button.setPointerCapture(event.pointerId);
    });

    button.addEventListener('pointermove', function (event) {
      if (!dragState || dragState.id !== event.pointerId) return;
      if (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1) moved = true;
      event.preventDefault();
      place(event.clientX - dragState.dx, event.clientY - dragState.dy);
    });

    button.addEventListener('pointerup', function (event) {
      if (!dragState || dragState.id !== event.pointerId) return;
      var rect = button.getBoundingClientRect();
      saveJson('position', place(rect.left, rect.top));
      dragState = null;
      if (!moved) openPanel();
    });

    button.addEventListener('click', function () {
      if (!dragState && !moved) openPanel();
    });

    window.addEventListener('resize', function () {
      var rect = button.getBoundingClientRect();
      saveJson('position', place(rect.left, rect.top));
    });
  }

  function ensureInterface() {
    if (!document.body) return;
    installStyles();

    var button = q('#' + ID + '-button');
    if (!button) {
      button = document.createElement('button');
      button.id = ID + '-button';
      button.type = 'button';
      button.textContent = 'Wage Calc';
      button.title = 'Tap to open. Drag to move.';
      document.body.appendChild(button);
      makeDraggable(button);
    }

    var overlay = q('#' + ID + '-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = ID + '-overlay';
      overlay.innerHTML = '<div id="' + ID + '-panel"></div>';
      overlay.addEventListener('click', function (event) { if (event.target === overlay) closePanel(); });
      document.body.appendChild(overlay);
    }
  }

  function showStartupError(error) {
    if (!document.body) return;
    var box = document.createElement('div');
    box.id = ID + '-startup-error';
    box.textContent = 'Wage Calculator startup error: ' + (error && error.message ? error.message : String(error));
    box.style.cssText = 'position:fixed;right:10px;bottom:90px;z-index:2147483647;max-width:320px;padding:10px;background:#651f1f;color:#fff;border:1px solid #ff9d9d;border-radius:8px;font:700 12px Arial';
    document.body.appendChild(box);
  }

  function start() {
    try {
      ensureInterface();
      new MutationObserver(function () {
        ensureInterface();
        improveEditorReadability();
        if (settings.autofillWage && selectedEmployeeId) fillSelectedWage();
      }).observe(document.documentElement, { childList: true, subtree: true });
      setInterval(ensureInterface, 2000);
    } catch (error) {
      showStartupError(error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
