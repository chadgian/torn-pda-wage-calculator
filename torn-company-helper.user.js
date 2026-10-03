// ==UserScript==
// @name         Torn Company Helper
// @namespace    wyn.torn.company.tools
// @version      2.0.4
// @description  Generic Torn company helper for wage planning, position-fit analysis, payroll balancing, export, and safe wage autofill.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/companies.php*
// @match        https://torn.com/companies.php*
// @updateURL    https://raw.githubusercontent.com/chadgian/torn-pda-wage-calculator/main/torn-company-helper.meta.js
// @downloadURL  https://raw.githubusercontent.com/chadgian/torn-pda-wage-calculator/main/torn-company-helper.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
'use strict';

var params = new URLSearchParams(location.search);
if (!/\/companies\.php$/i.test(location.pathname)) return;

var VERSION = '2.0.4';
try { console.log('[Torn Company Helper] v' + VERSION + ' starting'); } catch (e) {}
var ID = 'gb-wage-v204';
var PFX = 'gb-wage:';
var PDA_KEY = '###PDA-APIKEY###';
var CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
var FRESH_AGE = 15 * 60 * 1000;
var API_BASE = 'https://api.torn.com/v2';
var API_COMMENT = 'Torn Company Helper ' + VERSION;
var SUPPORT_URL = 'https://www.torn.com/profiles.php?XID=4325416';

var defaults = {
    mode: 'current',
    budget: 10000000,
    benchmark: 1000000,
    target: 100,
    stats: 35,
    eff: 65,
    min: 0,
    max: 25000000,
    round: 100,
    director: true,
    fill: false,
    positionAdvice: true,
    autoRefresh: true
};

var cfg = get('cfg', defaults);
Object.keys(defaults).forEach(function (k) {
    if (cfg[k] === undefined) cfg[k] = defaults[k];
});

var excluded = get('excluded', []);
var staff = [];
var positions = [];
var company = null;
var rows = [];
var busy = false;
var errorState = null;
var settingsOpen = false;
var detailId = '';
var lastLoadedAt = 0;
var ui = { query: '', filter: 'all', sort: 'score', direction: 'desc' };
var pendingId = '';
var pendingUntil = 0;

function isOwnCompanyView() {
    try { return new URLSearchParams(location.search).get('step') === 'your'; }
    catch (e) { return false; }
}

function get(k, fallback) {
    try {
        var value = JSON.parse(localStorage.getItem(PFX + k));
        return value == null ? fallback : value;
    } catch (e) {
        return fallback;
    }
}

function put(k, value) {
    try { localStorage.setItem(PFX + k, JSON.stringify(value)); } catch (e) {}
}

function remove(k) {
    try { localStorage.removeItem(PFX + k); } catch (e) {}
}

function sessionGet(k) {
    try { return sessionStorage.getItem(PFX + k) || ''; } catch (e) { return ''; }
}

function sessionPut(k, value) {
    try {
        if (value) sessionStorage.setItem(PFX + k, value);
        else sessionStorage.removeItem(PFX + k);
    } catch (e) {}
}

function num(v) {
    var parsed = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function fmt(v) {
    try { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num(v)); }
    catch (e) { return String(Math.round(num(v))); }
}

function money(v) {
    var x = num(v);
    return (x < 0 ? '-' : '') + '$' + fmt(Math.abs(x));
}

function pct(v, digits) {
    var x = num(v);
    if (!Number.isFinite(x)) x = 0;
    return x.toFixed(digits == null ? 1 : digits) + '%';
}

function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
}

function sum(list, fn) {
    return list.reduce(function (total, item) { return total + num(fn(item)); }, 0);
}

function avg(list, fn) {
    return list.length ? sum(list, fn) / list.length : 0;
}

function apiKey() {
    var sessionKey = sessionGet('sessionKey').trim();
    if (sessionKey) return sessionKey;
    var manual = String(get('key', '') || '').trim();
    if (manual) return manual;
    return PDA_KEY.indexOf('###PDA-APIKEY###') < 0 ? PDA_KEY.trim() : '';
}

function keySource() {
    if (sessionGet('sessionKey').trim()) return 'Session key';
    if (String(get('key', '') || '').trim()) return 'Saved key';
    if (PDA_KEY.indexOf('###PDA-APIKEY###') < 0) return 'Torn PDA key';
    return 'No key';
}

function nowText(ts) {
    if (!ts) return 'Never';
    var seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return 'Just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
}

function apiError(message, meta) {
    var e = new Error(message || 'Torn API request failed.');
    Object.keys(meta || {}).forEach(function (k) { e[k] = meta[k]; });
    return e;
}

function errorInfo(err) {
    var status = num(err && err.status);
    var code = num(err && err.code);
    var raw = String(err && err.message || err || 'Unknown error');
    var text = raw.toLowerCase();
    var title = 'Could not refresh company data';
    var solution = 'Try Refresh again. If the issue persists, open API Key and verify the key you are using.';

    if (!apiKey() || /no api key/.test(text)) {
        title = 'API key required';
        solution = 'Open API Key and use the Torn PDA key or add a Torn API key. The key is sent only to api.torn.com.';
    } else if (status === 401 || code === 2 || /incorrect key|invalid key|key is invalid/.test(text)) {
        title = 'API key rejected';
        solution = 'Replace the saved key. If Torn PDA normally supplies your key, clear the manual key so the script can use the PDA-provided key instead.';
    } else if (status === 403 || /permission|access level|not permitted|not allowed/.test(text)) {
        title = 'The key does not expose enough company data';
        solution = 'Use a key that can read your company employees. Directors need wage access for wage calculations; a Limited, Custom, or Full key is the safest choice when wage data is required.';
    } else if (status === 429 || code === 5 || /too many|rate limit/.test(text)) {
        title = 'Torn API rate limit reached';
        solution = 'Avoid repeatedly tapping Refresh. The last successful cached data remains available in the calculator.';
    } else if (/failed to fetch|network|load failed|internet/.test(text)) {
        title = 'Network request failed';
        solution = 'Check your connection and whether api.torn.com is reachable, then refresh. Your last cached data has not been removed.';
    } else if (/wage data/.test(text) || /wages are unavailable/.test(text)) {
        title = 'Employee wages are unavailable';
        solution = 'The API returned employees but not their wages. Wage planning requires wage visibility, which is normally available to the company director with an appropriate API key.';
    } else if (/position catalog/.test(text)) {
        title = 'Position catalog unavailable';
        solution = 'Wage calculations can still work, but position-fit recommendations need the company type catalog. Refresh once the Torn public company catalog is available.';
    }

    return { title: title, message: raw, solution: solution };
}


function diagnosticText(err) {
    var details = [
        'Torn Company Helper v' + VERSION,
        'Time: ' + new Date().toISOString(),
        'Company: ' + (company ? company.name + (company.typeName ? ' / ' + company.typeName : '') : 'Not loaded'),
        'Key source: ' + keySource(),
        'HTTP status: ' + (err && err.status != null ? err.status : 'n/a'),
        'Torn error code: ' + (err && err.code != null ? err.code : 'n/a'),
        'Error: ' + String(err && err.message || err || 'Unknown error')
    ];
    return details.join('\n');
}

async function api(path) {
    var k = apiKey();
    if (!k) throw apiError('No API key configured.');

    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var url = API_BASE + path + sep + 'comment=' + encodeURIComponent(API_COMMENT);
    var response;
    try {
        response = await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            headers: { 'Authorization': 'ApiKey ' + k, 'Accept': 'application/json' }
        });
    } catch (e) {
        throw apiError(e.message || 'Network request failed.', { cause: e });
    }

    var data;
    try { data = await response.json(); }
    catch (e) { throw apiError('Torn API returned an unreadable response.', { status: response.status }); }

    if (!response.ok || data.error) {
        var er = data && data.error || {};
        throw apiError(er.error || er.message || ('Torn API request failed (' + response.status + ').'), {
            status: response.status,
            code: er.code
        });
    }
    return data;
}

function normalizeEmployees(payload) {
    var source = payload && (payload.employees || payload.company_employees || payload.companyEmployees) || [];
    var list = Array.isArray(source) ? source : Object.keys(source || {}).map(function (id) {
        var copy = Object.assign({}, source[id] || {});
        if (copy.id == null) copy.id = id;
        return copy;
    });

    return list.map(function (x, index) {
        x = x || {};
        var s = x.stats || x.working_stats || x.work_stats || {};
        var effect = x.effectiveness;
        if (effect == null) effect = x.efficiency;
        if (typeof effect !== 'object' || Array.isArray(effect)) effect = { total: num(effect) };
        var p = x.position || {};
        var positionName = typeof p === 'object' ? (p.name || p.title || 'Unassigned') : (p || x.role || 'Unassigned');
        var positionId = typeof p === 'object' ? String(p.id == null ? '' : p.id) : '';
        var user = x.user || {};

        return {
            id: String(x.id || x.user_id || x.player_id || user.id || index),
            name: String(x.name || x.username || user.name || ('Employee ' + (index + 1))),
            position: String(positionName),
            positionId: positionId,
            manual: num(s.manual_labor != null ? s.manual_labor : s.manual != null ? s.manual : x.manual_labor != null ? x.manual_labor : x.manual),
            intelligence: num(s.intelligence != null ? s.intelligence : s.intel != null ? s.intel : x.intelligence != null ? x.intelligence : x.intel),
            endurance: num(s.endurance != null ? s.endurance : s.end != null ? s.end : x.endurance != null ? x.endurance : x.end),
            effectiveness: {
                working_stats: effect.working_stats == null ? null : num(effect.working_stats),
                settled_in: effect.settled_in == null ? null : num(effect.settled_in),
                book: effect.book == null ? null : num(effect.book),
                merits: effect.merits == null ? null : num(effect.merits),
                director_education: effect.director_education == null ? null : num(effect.director_education),
                management: effect.management == null ? null : num(effect.management),
                wrong_gender: effect.wrong_gender == null ? null : num(effect.wrong_gender),
                addiction: effect.addiction == null ? null : num(effect.addiction),
                inactivity: effect.inactivity == null ? null : num(effect.inactivity),
                total: num(effect.total != null ? effect.total : effect.overall != null ? effect.overall : effect.value)
            },
            wage: x.wage == null && x.salary == null && x.daily_wage == null && x.pay == null ? null : num(x.wage != null ? x.wage : x.salary != null ? x.salary : x.daily_wage != null ? x.daily_wage : x.pay),
            days: num(x.days_in_company),
            joinedAt: num(x.joined_at),
            status: x.status || null,
            lastAction: x.last_action || null,
            director: !!x.is_director || /director/i.test(String(positionName))
        };
    });
}

function normalizeCompany(payload) {
    var p = payload && (payload.profile || payload.company || payload) || {};
    var type = p.type || {};
    return {
        id: String(p.id || ''),
        name: String(p.name || 'Your company'),
        typeId: String(typeof type === 'object' ? (type.id || '') : (p.company_type || type || '')),
        typeName: String(typeof type === 'object' ? (type.name || '') : ''),
        rating: num(p.rating),
        employeeCount: num(p.employees && p.employees.hired),
        capacity: num(p.employees && p.employees.capacity),
        dailyIncome: num(p.income && p.income.daily),
        weeklyIncome: num(p.income && p.income.weekly)
    };
}

function normalizePositions(payload, typeId) {
    var source = payload && (payload.companies || payload.company_types) || [];
    var catalog = Array.isArray(source) ? source : Object.keys(source || {}).map(function (id) {
        var item = Object.assign({}, source[id] || {});
        if (item.id == null) item.id = id;
        return item;
    });
    var type = catalog.find(function (x) { return String(x.id) === String(typeId); }) || catalog[0] || {};
    var positionSource = type.positions || [];
    var list = Array.isArray(positionSource) ? positionSource : Object.keys(positionSource || {}).map(function (id) {
        var item = Object.assign({}, positionSource[id] || {});
        if (item.id == null) item.id = id;
        return item;
    });
    return list.map(function (p) {
        var req = p.working_stats && p.working_stats.required || p.required_working_stats || {};
        var gains = p.working_stats && p.working_stats.daily_gains || p.daily_gains || {};
        return {
            id: String(p.id == null ? '' : p.id),
            name: String(p.name || 'Unknown position'),
            description: String(p.description || ''),
            ability: String(p.ability || ''),
            required: {
                manual: num(req.manual_labor != null ? req.manual_labor : req.manual),
                intelligence: num(req.intelligence != null ? req.intelligence : req.intel),
                endurance: num(req.endurance != null ? req.endurance : req.end)
            },
            gains: {
                manual: num(gains.manual_labor != null ? gains.manual_labor : gains.manual),
                intelligence: num(gains.intelligence != null ? gains.intelligence : gains.intel),
                endurance: num(gains.endurance != null ? gains.endurance : gains.end)
            }
        };
    });
}

function statEfficiency(stat, required) {
    stat = Math.max(0, num(stat));
    required = num(required);
    if (required <= 0) return 0;
    var base = Math.min(45, (45 / required) * stat);
    var bonus = stat > 0 ? Math.max(0, 5 * (Math.log(stat / required) / Math.log(2))) : 0;
    return Math.floor(Math.max(0, base + bonus));
}

function positionFit(employee, position) {
    if (!position) return 0;
    var total = 0;
    var used = 0;
    [
        ['manual', employee.manual],
        ['intelligence', employee.intelligence],
        ['endurance', employee.endurance]
    ].forEach(function (pair) {
        var req = num(position.required[pair[0]]);
        if (req > 0) {
            total += statEfficiency(pair[1], req);
            used++;
        }
    });
    return used ? total : 0;
}

function currentPosition(employee) {
    var byId = positions.find(function (p) { return employee.positionId && String(p.id) === String(employee.positionId); });
    if (byId) return byId;
    var name = String(employee.position || '').toLowerCase();
    return positions.find(function (p) { return p.name.toLowerCase() === name; }) || null;
}

function bestPosition(employee) {
    if (!positions.length || employee.director) return null;
    var ranked = positions.map(function (p) { return { position: p, fit: positionFit(employee, p) }; });
    ranked.sort(function (a, b) { return b.fit - a.fit || a.position.name.localeCompare(b.position.name); });
    return ranked[0] || null;
}

function constrainedRaw(weights, target, minimum, maximum) {
    var n = weights.length;
    if (!n) return [];
    minimum = num(minimum);
    maximum = Math.max(minimum, num(maximum));
    var feasible = clamp(num(target), minimum * n, maximum * n);
    var out = new Array(n).fill(minimum);
    var active = weights.map(function (_, i) { return i; });
    var remaining = feasible - minimum * n;
    var guard = 0;

    while (remaining > 0.0001 && active.length && guard++ < n + 5) {
        var totalWeight = active.reduce(function (t, i) { return t + Math.max(0.000001, num(weights[i])); }, 0);
        var capped = [];
        var distributed = 0;

        active.forEach(function (i) {
            var share = remaining * Math.max(0.000001, num(weights[i])) / totalWeight;
            var room = maximum - out[i];
            if (share >= room - 0.0001) {
                distributed += room;
                out[i] = maximum;
                capped.push(i);
            }
        });

        if (!capped.length) {
            active.forEach(function (i) {
                out[i] += remaining * Math.max(0.000001, num(weights[i])) / totalWeight;
            });
            remaining = 0;
            break;
        }

        remaining -= distributed;
        active = active.filter(function (i) { return capped.indexOf(i) < 0; });
    }
    return out;
}

function roundBalanced(raw, target, minimum, maximum, step) {
    step = Math.max(1, Math.round(num(step)));
    minimum = num(minimum);
    maximum = Math.max(minimum, num(maximum));
    var feasible = clamp(num(target), minimum * raw.length, maximum * raw.length);
    var rounded = raw.map(function (v) {
        return clamp(Math.round(v / step) * step, minimum, maximum);
    });
    var diff = feasible - sum(rounded, function (v) { return v; });
    var loops = 0;

    while (Math.abs(diff) >= step / 2 && loops++ < raw.length * 4 + 20) {
        if (diff > 0) {
            var up = raw.map(function (v, i) { return { i:i, desire:v-rounded[i] }; })
                .filter(function (x) { return rounded[x.i] + step <= maximum; })
                .sort(function (a,b) { return b.desire - a.desire; });
            if (!up.length) break;
            var changedUp = false;
            for (var a = 0; a < up.length && diff >= step / 2; a++) {
                rounded[up[a].i] += step;
                diff -= step;
                changedUp = true;
            }
            if (!changedUp) break;
        } else {
            var down = raw.map(function (v, i) { return { i:i, desire:rounded[i]-v }; })
                .filter(function (x) { return rounded[x.i] - step >= minimum; })
                .sort(function (a,b) { return b.desire - a.desire; });
            if (!down.length) break;
            var changedDown = false;
            for (var d = 0; d < down.length && diff <= -step / 2; d++) {
                rounded[down[d].i] -= step;
                diff += step;
                changedDown = true;
            }
            if (!changedDown) break;
        }
    }
    return rounded;
}

function calculate() {
    var included = staff.filter(function (x) {
        return excluded.indexOf(x.id) < 0 && (cfg.director || !x.director);
    });

    var totalWeight = Math.max(1, num(cfg.stats) + num(cfg.eff));
    var targetEff = Math.max(1, num(cfg.target));

    var calcRows = included.map(function (employee) {
        var currentPos = currentPosition(employee);
        var predictedFit = currentPos ? positionFit(employee, currentPos) : 0;
        var actualWorkFit = employee.effectiveness.working_stats == null ? predictedFit : num(employee.effectiveness.working_stats);
        var totalEff = num(employee.effectiveness.total);
        var statFactor = clamp(actualWorkFit / 100, 0.05, 3);
        var effFactor = clamp(totalEff / targetEff, 0.05, 3);
        var score = (statFactor * num(cfg.stats) + effFactor * num(cfg.eff)) / totalWeight;
        var best = cfg.positionAdvice ? bestPosition(employee) : null;
        return Object.assign({}, employee, {
            score: score,
            currentFit: actualWorkFit,
            predictedCurrentFit: predictedFit,
            bestPosition: best && best.position || null,
            bestFit: best ? best.fit : 0
        });
    });

    var minimum = Math.max(0, num(cfg.min));
    var maximum = Math.max(minimum, num(cfg.max));
    var step = Math.max(1, num(cfg.round));
    var currentIncluded = sum(calcRows, function (x) { return x.wage == null ? 0 : x.wage; });
    var budgetTarget = cfg.mode === 'fixed' ? Math.max(0, num(cfg.budget)) : currentIncluded;
    var suggested = [];

    if (cfg.mode === 'benchmark') {
        suggested = calcRows.map(function (x) {
            var raw = clamp(num(cfg.benchmark) * x.score, minimum, maximum);
            return clamp(Math.round(raw / step) * step, minimum, maximum);
        });
    } else {
        var raw = constrainedRaw(calcRows.map(function (x) { return x.score; }), budgetTarget, minimum, maximum);
        suggested = roundBalanced(raw, budgetTarget, minimum, maximum, step);
    }

    var includedMap = {};
    calcRows.forEach(function (x, i) {
        x.suggested = suggested[i];
        x.change = x.wage == null ? 0 : x.suggested - x.wage;
        x.changePct = x.wage > 0 ? (x.change / x.wage) * 100 : 0;
        includedMap[x.id] = x;
    });

    rows = staff.map(function (employee) {
        var inCalc = includedMap[employee.id];
        if (inCalc) return inCalc;
        var currentPos = currentPosition(employee);
        var best = cfg.positionAdvice ? bestPosition(employee) : null;
        return Object.assign({}, employee, {
            score: 0,
            currentFit: employee.effectiveness.working_stats == null ? (currentPos ? positionFit(employee, currentPos) : 0) : num(employee.effectiveness.working_stats),
            predictedCurrentFit: currentPos ? positionFit(employee, currentPos) : 0,
            bestPosition: best && best.position || null,
            bestFit: best ? best.fit : 0,
            suggested: employee.wage == null ? 0 : employee.wage,
            change: 0,
            changePct: 0,
            omit: true
        });
    });

    rows.forEach(function (x) {
        x.omit = !includedMap[x.id];
        x.recommendPosition = !!(x.bestPosition && !x.director && x.bestPosition.name !== x.position && x.bestFit >= x.predictedCurrentFit + 3);
    });

    var suggestedIncluded = sum(calcRows, function (x) { return x.suggested; });
    var currentAll = sum(staff, function (x) { return x.wage == null ? 0 : x.wage; });
    var suggestedAll = sum(rows, function (x) { return x.suggested; });
    var effectiveTarget = cfg.mode === 'benchmark' ? suggestedIncluded : budgetTarget;

    return {
        rows: rows,
        included: calcRows.length,
        excluded: staff.length - calcRows.length,
        currentIncluded: currentIncluded,
        suggestedIncluded: suggestedIncluded,
        currentAll: currentAll,
        suggestedAll: suggestedAll,
        target: effectiveTarget,
        budgetGap: cfg.mode === 'benchmark' ? 0 : suggestedIncluded - budgetTarget,
        avgEffectiveness: avg(calcRows, function (x) { return x.effectiveness.total; }),
        avgFit: avg(calcRows, function (x) { return x.currentFit; })
    };
}

function cacheData() {
    put('cache', {
        ts: Date.now(),
        staff: staff,
        positions: positions,
        company: company
    });
}

function restoreCache() {
    var c = get('cache', null);
    if (!c || !c.ts || Date.now() - c.ts > CACHE_MAX_AGE || !Array.isArray(c.staff)) return false;
    staff = c.staff;
    positions = Array.isArray(c.positions) ? c.positions : [];
    company = c.company || null;
    lastLoadedAt = c.ts;
    return true;
}

async function fetchAll() {
    var pair = await Promise.all([api('/company/employees'), api('/company/profile')]);
    var nextStaff = normalizeEmployees(pair[0]);
    var nextCompany = normalizeCompany(pair[1]);

    if (!nextStaff.length) throw apiError('No employees were returned for your company.');
    var missingWages = nextStaff.filter(function (x) { return x.wage == null; }).length;
    if (missingWages) throw apiError('Wage data is incomplete for ' + missingWages + ' of ' + nextStaff.length + ' employees. Wage data is required for accurate payroll recommendations.');

    var nextPositions = [];
    if (nextCompany.typeId) {
        try {
            var catalog = await api('/torn/' + encodeURIComponent(nextCompany.typeId) + '/companies');
            nextPositions = normalizePositions(catalog, nextCompany.typeId);
        } catch (e) {
            nextPositions = [];
            e.positionCatalogOnly = true;
        }
    }

    staff = nextStaff;
    company = nextCompany;
    positions = nextPositions;
    lastLoadedAt = Date.now();
    cacheData();
}

function displayRows(result) {
    var q = ui.query.trim().toLowerCase();
    var out = result.rows.filter(function (x) {
        if (q && [x.name, x.position, x.bestPosition && x.bestPosition.name, x.id].join(' ').toLowerCase().indexOf(q) < 0) return false;
        if (ui.filter === 'included' && x.omit) return false;
        if (ui.filter === 'excluded' && !x.omit) return false;
        if (ui.filter === 'raise' && (x.omit || x.change <= 0)) return false;
        if (ui.filter === 'cut' && (x.omit || x.change >= 0)) return false;
        if (ui.filter === 'position' && !x.recommendPosition) return false;
        return true;
    });

    function value(x) {
        if (ui.sort === 'name') return x.name.toLowerCase();
        if (ui.sort === 'wage') return x.wage == null ? -1 : x.wage;
        if (ui.sort === 'suggested') return x.suggested;
        if (ui.sort === 'effectiveness') return x.effectiveness.total;
        if (ui.sort === 'fit') return x.currentFit;
        if (ui.sort === 'change') return Math.abs(x.change);
        return x.score;
    }

    out.sort(function (a, b) {
        var av = value(a), bv = value(b), cmp;
        if (typeof av === 'string') cmp = av.localeCompare(bv);
        else cmp = av - bv;
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        return ui.direction === 'asc' ? cmp : -cmp;
    });
    return out;
}

function changeLabel(x) {
    if (x.omit) return '<span class="tag muted">Excluded</span>';
    if (x.change > 0) return '<span class="tag raise">Raise</span>';
    if (x.change < 0) return '<span class="tag cut">Cut</span>';
    return '<span class="tag keep">Keep</span>';
}

function positionLabel(x) {
    if (!cfg.positionAdvice || !positions.length || x.director) return '<span class="subtle">—</span>';
    if (!x.bestPosition) return '<span class="subtle">—</span>';
    var recommendation = x.recommendPosition ? '<b>' + esc(x.bestPosition.name) + '</b>' : '<span class="subtle">Current is suitable</span>';
    return recommendation + '<small class="cell-note">Best stat fit ' + fmt(x.bestFit) + '</small>';
}

function detailHtml(x) {
    if (!x) return '';
    var e = x.effectiveness || {};
    var best = x.bestPosition;
    var req = best && best.required;
    return '<div class="detail-card">' +
        '<div class="detail-head"><div><small>Employee analysis</small><h3>' + esc(x.name) + ' <span>[' + esc(x.id) + ']</span></h3></div><button class="icon-btn" data-a="detail-close" aria-label="Close employee analysis">×</button></div>' +
        '<div class="detail-grid">' +
            '<div><small>Current position</small><b>' + esc(x.position) + '</b></div>' +
            '<div><small>Work-stat efficiency</small><b>' + fmt(x.currentFit) + '</b></div>' +
            '<div><small>Total effectiveness</small><b>' + fmt(e.total) + '</b></div>' +
            '<div><small>Wage score</small><b>' + (x.omit ? 'Excluded' : x.score.toFixed(3)) + '</b></div>' +
            '<div><small>Current wage</small><b>' + (x.wage == null ? 'Unavailable' : money(x.wage)) + '</b></div>' +
            '<div><small>Suggested wage</small><b>' + money(x.suggested) + '</b></div>' +
        '</div>' +
        '<h4>Effectiveness breakdown</h4>' +
        '<div class="breakdown">' +
            effectLine('Working stats', e.working_stats) +
            effectLine('Settled in', e.settled_in) +
            effectLine('Book', e.book) +
            effectLine('Merits', e.merits) +
            effectLine('Director education', e.director_education) +
            effectLine('Management', e.management) +
            effectLine('Wrong gender', e.wrong_gender) +
            effectLine('Addiction', e.addiction) +
            effectLine('Inactivity', e.inactivity) +
        '</div>' +
        (best && !x.director ? '<h4>Best stat-fit position</h4><div class="position-box"><div><b>' + esc(best.name) + '</b><small>' + esc(best.description || best.ability || 'Based on work-stat requirements only.') + '</small></div><strong>' + fmt(x.bestFit) + '</strong></div>' +
        '<div class="requirements"><span>Requires:</span>' + requirementBadge('MAN', req.manual) + requirementBadge('INT', req.intelligence) + requirementBadge('END', req.endurance) + '</div>' : '') +
        '<p class="detail-note">Position recommendations compare work-stat fit only. They do not replace company-specific staffing strategy, position abilities, or director judgment.</p>' +
    '</div>';
}

function effectLine(label, value) {
    if (!num(value)) return '';
    var cls = num(value) < 0 ? 'neg' : 'pos';
    return '<div><span>' + esc(label) + '</span><b class="' + cls + '">' + (num(value) > 0 ? '+' : '') + fmt(value) + '</b></div>';
}

function requirementBadge(label, value) {
    return num(value) > 0 ? '<b>' + label + ' ' + fmt(value) + '</b>' : '';
}

function settingField(k, label, note, kind) {
    var control;
    if (kind === 'mode') {
        control = '<select data-set="' + k + '">' +
            '<option value="current"' + (cfg[k] === 'current' ? ' selected' : '') + '>Keep included payroll</option>' +
            '<option value="fixed"' + (cfg[k] === 'fixed' ? ' selected' : '') + '>Fixed included budget</option>' +
            '<option value="benchmark"' + (cfg[k] === 'benchmark' ? ' selected' : '') + '>Benchmark × score</option>' +
        '</select>';
    } else {
        control = '<input data-num="' + k + '" inputmode="numeric" value="' + esc(fmt(cfg[k])) + '">';
    }
    return '<label class="setting"><span>' + esc(label) + '</span>' + control + '<small>' + esc(note) + '</small></label>';
}

function render() {
    var panel = S.querySelector('#panel');
    var result = staff.length ? calculate() : null;
    var visibleRows = result ? displayRows(result) : [];
    var stale = lastLoadedAt && Date.now() - lastLoadedAt > FRESH_AGE;
    var companyLine = company ? [company.name, company.typeName, company.rating ? company.rating + '★' : ''].filter(Boolean).join(' • ') : 'Company wage planning';

    var html = '';
    html += '<header>' +
        '<div class="brand"><div class="logo">TC</div><div><h2>Torn Company Helper <span>v' + VERSION + '</span></h2><p>' + esc(companyLine) + '</p></div></div>' +
        '<div class="header-actions"><span class="refresh-state ' + (stale ? 'stale' : '') + '">' + (lastLoadedAt ? 'Updated ' + nowText(lastLoadedAt) : 'Not loaded') + '</span><button class="icon-btn" data-a="close" aria-label="Close">×</button></div>' +
    '</header>';

    html += '<div class="actionbar">' +
        '<button class="primary" data-a="load"' + (busy ? ' disabled' : '') + '>' + (busy ? '<span class="spinner"></span> Refreshing' : '↻ Refresh API') + '</button>' +
        '<button data-a="settings">⚙ Settings</button>' +
        '<button data-a="key">🔑 API Key</button>' +
        '<button data-a="copy"' + (!result ? ' disabled' : '') + '>⧉ Copy wages</button>' +
        '<button data-a="csv"' + (!result ? ' disabled' : '') + '>⇩ Export CSV</button>' +
    '</div>';

    if (settingsOpen) {
        html += '<section class="settings">' +
            '<div class="section-title"><div><h3>Wage model</h3><p>Changes update the recommendations immediately. Nothing is submitted to Torn.</p></div><button class="text-btn" data-a="reset-settings">Reset defaults</button></div>' +
            '<div class="settings-grid">' +
                settingField('mode', 'Payment model', 'Current keeps the included wage pool. Fixed uses your budget. Benchmark pays score × benchmark.', 'mode') +
                settingField('budget', 'Fixed daily payroll', 'Used only in Fixed budget mode.') +
                settingField('benchmark', 'Benchmark wage', 'A score of 1.000 receives approximately this daily wage.') +
                settingField('target', 'Target effectiveness', 'Effectiveness treated as the baseline 1.000 contribution.') +
                settingField('stats', 'Position-fit weight', 'Weight given to the employee work-stat efficiency in their current role.') +
                settingField('eff', 'Total-effectiveness weight', 'Weight given to current total effectiveness, including modifiers.') +
                settingField('min', 'Minimum wage', 'Floor applied to every included employee.') +
                settingField('max', 'Maximum wage', 'Cap applied to every included employee.') +
                settingField('round', 'Round to', 'Use 100, 1,000, 10,000, etc. The allocator tries to preserve the chosen total budget.') +
            '</div>' +
            '<div class="toggles">' +
                toggle('director', 'Include director', 'Include the director in wage distribution.') +
                toggle('fill', 'Safe wage autofill', 'When you tap a matching Torn wage field, fill the recommendation but never press Update/Save.') +
                toggle('positionAdvice', 'Position-fit advice', 'Compare each employee against the actual positions for this company type.') +
                toggle('autoRefresh', 'Refresh on open', 'Refresh automatically when the panel opens and cached data is old.') +
            '</div>' +
        '</section>';
    }

    if (errorState) {
        var info = errorInfo(errorState);
        html += '<div class="error-card"><div class="error-icon">!</div><div><b>' + esc(info.title) + '</b><p>' + esc(info.message) + '</p><small><strong>Suggested fix:</strong> ' + esc(info.solution) + '</small><div class="error-actions"><button data-a="copy-error">Copy error details</button><a href="' + esc(SUPPORT_URL) + '" target="_blank" rel="noopener noreferrer">Contact developer</a></div></div><button data-a="dismiss-error">×</button></div>';
    }

    if (!result && !busy) {
        html += '<section class="empty">' +
            '<div class="empty-icon">$</div><h3>Load your company to start</h3><p>The calculator reads employees, wages, effectiveness, and your company type from the Torn API. It does not submit wage changes.</p>' +
            '<div><button class="primary" data-a="load">Refresh API</button><button data-a="key">API Key</button></div>' +
        '</section>';
    }

    if (result) {
        var delta = result.suggestedIncluded - result.currentIncluded;
        html += '<section class="summary">' +
            summaryCard('Included employees', fmt(result.included), result.excluded ? fmt(result.excluded) + ' excluded' : 'All employees included') +
            summaryCard('Included payroll', money(result.currentIncluded), 'Current daily total') +
            summaryCard('Suggested payroll', money(result.suggestedIncluded), (delta > 0 ? '+' : '') + money(delta) + ' vs current', delta > 0 ? 'warn' : delta < 0 ? 'good' : '') +
            summaryCard('Avg. effectiveness', fmt(result.avgEffectiveness), 'Avg. work-stat eff. ' + fmt(result.avgFit)) +
            summaryCard('Budget variance', cfg.mode === 'benchmark' ? '—' : money(result.budgetGap), cfg.mode === 'benchmark' ? 'Not budget-constrained' : 'Difference after limits & rounding', Math.abs(result.budgetGap) > num(cfg.round) ? 'warn' : 'good') +
        '</section>';

        if (!positions.length) {
            html += '<div class="notice"><b>Position-fit advice unavailable.</b> Wage calculations are active, but the company type position catalog could not be loaded.</div>';
        }

        html += '<section class="workspace">' +
            '<div class="toolbar">' +
                '<div class="search"><span>⌕</span><input data-ui="query" value="' + esc(ui.query) + '" placeholder="Search employee, ID, or position" aria-label="Search employees"></div>' +
                '<select data-ui="sort" aria-label="Sort employees">' + sortOptions() + '</select>' +
                '<button class="small" data-a="sort-dir" title="Toggle sort direction">' + (ui.direction === 'desc' ? '↓' : '↑') + '</button>' +
                '<button class="small" data-a="reset-inclusions">Include all</button>' +
            '</div>' +
            '<div class="filters">' + filterButton('all', 'All', result.rows.length) + filterButton('included', 'Included', result.included) + filterButton('excluded', 'Excluded', result.excluded) + filterButton('raise', 'Raises', result.rows.filter(function(x){return !x.omit&&x.change>0;}).length) + filterButton('cut', 'Cuts', result.rows.filter(function(x){return !x.omit&&x.change<0;}).length) + filterButton('position', 'Position review', result.rows.filter(function(x){return x.recommendPosition;}).length) + '</div>' +
            '<div class="table-meta"><span>Showing <b>' + fmt(visibleRows.length) + '</b> of ' + fmt(result.rows.length) + '</span><span>Drag horizontally on the table to view all columns.</span></div>' +
            '<div class="table-wrap"><table><thead><tr>' +
                '<th class="sticky-check">Use</th><th class="sticky-name">Employee</th><th>Current position</th><th>Position fit</th><th>MAN</th><th>INT</th><th>END</th><th>Eff.</th><th>Score</th><th>Current wage</th><th>Suggested</th><th>Change</th><th>Status</th><th></th>' +
            '</tr></thead><tbody>';

        visibleRows.forEach(function (x) {
            var posFit = cfg.positionAdvice && x.bestPosition ? fmt(x.currentFit) + ' <span class="arrow">→</span> ' + fmt(x.bestFit) : fmt(x.currentFit);
            html += '<tr class="' + (x.omit ? 'excluded-row' : '') + '">' +
                '<td class="sticky-check"><input type="checkbox" data-inc="' + esc(x.id) + '"' + (!x.omit ? ' checked' : '') + ' aria-label="Include ' + esc(x.name) + '"></td>' +
                '<td class="sticky-name"><button class="employee-link" data-detail="' + esc(x.id) + '">' + esc(x.name) + '</button><small>[' + esc(x.id) + ']</small></td>' +
                '<td><b>' + esc(x.position) + '</b><small class="cell-note">' + (x.days ? fmt(x.days) + ' days in company' : '') + '</small></td>' +
                '<td class="fit-cell"><b>' + posFit + '</b>' + (x.recommendPosition ? '<small class="cell-note attention">Review: ' + esc(x.bestPosition.name) + '</small>' : '') + '</td>' +
                '<td>' + fmt(x.manual) + '</td><td>' + fmt(x.intelligence) + '</td><td>' + fmt(x.endurance) + '</td>' +
                '<td><b>' + fmt(x.effectiveness.total) + '</b><small class="cell-note">Work ' + fmt(x.currentFit) + '</small></td>' +
                '<td>' + (x.omit ? '—' : x.score.toFixed(3)) + '</td>' +
                '<td>' + (x.wage == null ? '<span class="subtle">Unavailable</span>' : money(x.wage)) + '</td>' +
                '<td class="suggested"><b>' + money(x.suggested) + '</b></td>' +
                '<td class="' + (x.change > 0 ? 'positive' : x.change < 0 ? 'negative' : '') + '">' + (x.change > 0 ? '+' : '') + money(x.change) + (x.wage > 0 && x.change ? '<small class="cell-note">' + (x.changePct > 0 ? '+' : '') + pct(x.changePct) + '</small>' : '') + '</td>' +
                '<td>' + changeLabel(x) + '</td>' +
                '<td><button class="row-action" data-copy-one="' + esc(x.id) + '" title="Copy suggested wage">⧉</button></td>' +
            '</tr>';
        });

        if (!visibleRows.length) html += '<tr><td colspan="14" class="no-results">No employees match this view.</td></tr>';
        html += '</tbody></table></div></section>';
    }

    html += '<footer><span>API: ' + esc(keySource()) + '</span><span>Advisory only — wage changes are never submitted automatically.</span></footer>';
    if (detailId && result) html += '<div class="detail-overlay" data-a="detail-close"><div class="detail-shell">' + detailHtml(result.rows.find(function(x){return x.id===detailId;})) + '</div></div>';

    panel.innerHTML = html;
    bind(result);
}

function summaryCard(label, value, note, cls) {
    return '<div class="summary-card ' + (cls || '') + '"><small>' + esc(label) + '</small><b>' + esc(value) + '</b><span>' + esc(note) + '</span></div>';
}

function toggle(k, label, note) {
    return '<label class="toggle"><input type="checkbox" data-set="' + k + '"' + (cfg[k] ? ' checked' : '') + '><span class="switch"></span><div><b>' + esc(label) + '</b><small>' + esc(note) + '</small></div></label>';
}

function filterButton(key, label, count) {
    return '<button class="filter ' + (ui.filter === key ? 'active' : '') + '" data-filter="' + key + '">' + esc(label) + '<span>' + fmt(count) + '</span></button>';
}

function sortOptions() {
    return [
        ['score','Wage score'],['name','Name'],['wage','Current wage'],['suggested','Suggested wage'],['effectiveness','Effectiveness'],['fit','Position fit'],['change','Largest change']
    ].map(function (x) { return '<option value="' + x[0] + '"' + (ui.sort === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('');
}

function bind(result) {
    var panel = S.querySelector('#panel');
    panel.querySelectorAll('[data-a="close"]').forEach(function (b) { b.onclick = closePanel; });
    panel.querySelectorAll('[data-a="load"]').forEach(function (b) { b.onclick = load; });
    panel.querySelectorAll('[data-a="key"]').forEach(function (b) { b.onclick = showKey; });

    var settings = panel.querySelector('[data-a="settings"]');
    if (settings) settings.onclick = function () { settingsOpen = !settingsOpen; render(); };

    var dismiss = panel.querySelector('[data-a="dismiss-error"]');
    if (dismiss) dismiss.onclick = function () { errorState = null; render(); };
    var copyError = panel.querySelector('[data-a="copy-error"]');
    if (copyError) copyError.onclick = function () {
        copyText(diagnosticText(errorState)).then(function () { toast('Error details copied.', true); });
    };

    var resetSettings = panel.querySelector('[data-a="reset-settings"]');
    if (resetSettings) resetSettings.onclick = function () {
        cfg = Object.assign({}, defaults);
        put('cfg', cfg);
        toast('Settings reset to defaults.', true);
        render();
    };

    var resetInc = panel.querySelector('[data-a="reset-inclusions"]');
    if (resetInc) resetInc.onclick = function () {
        excluded = [];
        put('excluded', excluded);
        render();
    };

    var sortDir = panel.querySelector('[data-a="sort-dir"]');
    if (sortDir) sortDir.onclick = function () { ui.direction = ui.direction === 'desc' ? 'asc' : 'desc'; render(); };

    panel.querySelectorAll('[data-set]').forEach(function (input) {
        input.onchange = function () {
            var k = input.dataset.set;
            cfg[k] = input.type === 'checkbox' ? input.checked : input.value;
            put('cfg', cfg);
            render();
        };
    });

    panel.querySelectorAll('[data-num]').forEach(function (input) {
        input.onfocus = function () { input.select(); };
        input.oninput = function () {
            var digits = input.value.replace(/[^0-9]/g, '');
            input.value = digits ? fmt(digits) : '';
        };
        input.onchange = function () {
            cfg[input.dataset.num] = Math.max(0, num(input.value));
            put('cfg', cfg);
            render();
        };
    });

    var query = panel.querySelector('[data-ui="query"]');
    if (query) {
        query.oninput = function () {
            ui.query = query.value;
            var pos = query.selectionStart;
            render();
            var next = panel.querySelector('[data-ui="query"]');
            if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch (e) {} }
        };
    }

    var sort = panel.querySelector('[data-ui="sort"]');
    if (sort) sort.onchange = function () { ui.sort = sort.value; render(); };

    panel.querySelectorAll('[data-filter]').forEach(function (b) {
        b.onclick = function () { ui.filter = b.dataset.filter; render(); };
    });

    panel.querySelectorAll('[data-inc]').forEach(function (input) {
        input.onchange = function () {
            var id = input.dataset.inc;
            var at = excluded.indexOf(id);
            if (input.checked && at >= 0) excluded.splice(at, 1);
            if (!input.checked && at < 0) excluded.push(id);
            put('excluded', excluded);
            render();
        };
    });

    panel.querySelectorAll('[data-detail]').forEach(function (b) {
        b.onclick = function () { detailId = b.dataset.detail; render(); };
    });

    panel.querySelectorAll('[data-a="detail-close"]').forEach(function (b) {
        b.onclick = function (e) {
            if (e.currentTarget === e.target || e.currentTarget.classList.contains('icon-btn')) {
                detailId = '';
                render();
            }
        };
    });

    panel.querySelectorAll('[data-copy-one]').forEach(function (b) {
        b.onclick = function () {
            var x = rows.find(function (r) { return r.id === b.dataset.copyOne; });
            if (x) copyText(x.name + ' [' + x.id + '] - ' + money(x.suggested) + ' per day').then(function(){ toast('Copied ' + x.name + ' wage.', true); });
        };
    });

    var copy = panel.querySelector('[data-a="copy"]');
    if (copy && result) copy.onclick = function () {
        var text = result.rows.filter(function (x) { return !x.omit; }).map(function (x) {
            return x.name + ' [' + x.id + '] - ' + money(x.suggested) + ' per day';
        }).join('\n');
        copyText(text).then(function () { toast('Included wage recommendations copied.', true); });
    };

    var csv = panel.querySelector('[data-a="csv"]');
    if (csv && result) csv.onclick = function () { exportCsv(result.rows); };
}

async function load() {
    if (busy) return;
    busy = true;
    errorState = null;
    render();
    try {
        await fetchAll();
        toast('Company data refreshed.', true);
    } catch (e) {
        errorState = e;
    } finally {
        busy = false;
        render();
    }
}

function openPanel() {
    S.querySelector('#overlay').classList.add('show');
    render();
    if (cfg.autoRefresh && apiKey() && (!lastLoadedAt || Date.now() - lastLoadedAt > FRESH_AGE) && !busy) load();
}

function closePanel() {
    detailId = '';
    S.querySelector('#overlay').classList.remove('show');
}

function showKey() {
    var box = S.querySelector('#keybox');
    var input = box.querySelector('input[type="password"]');
    var remember = box.querySelector('[data-k="remember"]');
    var persistent = String(get('key', '') || '');
    var session = sessionGet('sessionKey');
    input.value = session || persistent || '';
    remember.checked = !!persistent && !session;
    box.querySelector('[data-k="status"]').textContent = keySource() + '. Keys are sent only to api.torn.com; API requests use the Authorization header.';
    box.classList.add('show');
    input.focus();
}

function saveKey() {
    var box = S.querySelector('#keybox');
    var input = box.querySelector('input[type="password"]');
    var remember = box.querySelector('[data-k="remember"]');
    var value = input.value.trim();    if (!value) return;
    if (remember.checked) {
        put('key', value);
        sessionPut('sessionKey', '');
    } else {
        remove('key');
        sessionPut('sessionKey', value);
    }
    box.classList.remove('show');
    errorState = null;
    toast('API key saved for ' + (remember.checked ? 'this device.' : 'this session.'), true);
    render();
}

function clearKey() {
    remove('key');
    sessionPut('sessionKey', '');
    var box = S.querySelector('#keybox');
    box.querySelector('input[type="password"]').value = '';
    box.querySelector('[data-k="status"]').textContent = PDA_KEY.indexOf('###PDA-APIKEY###') < 0 ? 'Manual key cleared. Torn PDA key will be used.' : 'No key configured.';
    toast('Manual API key cleared.', true);
    render();
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            resolve();
        } catch (e) { reject(e); }
    });
}

function exportCsv(data) {
    var headers = ['Employee','Torn ID','Included','Current Position','Best Stat-Fit Position','MAN','INT','END','Work-Stat Efficiency','Total Effectiveness','Score','Current Wage','Suggested Wage','Change'];
    var lines = [headers].concat(data.map(function (x) {
        return [x.name,x.id,x.omit?'No':'Yes',x.position,x.bestPosition?x.bestPosition.name:'',x.manual,x.intelligence,x.endurance,x.currentFit,x.effectiveness.total,x.omit?'':x.score.toFixed(3),x.wage == null ? '' : x.wage,x.suggested,x.change];
    })).map(function (row) {
        return row.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');

    var blob = new Blob([lines], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'torn-company-wages-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('CSV exported.', true);
}

function toast(message, ok) {
    var t = S.querySelector('#toast');
    t.textContent = message;
    t.className = 'show ' + (ok ? 'ok' : 'bad');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.className = ''; }, 2200);
}

function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    return !!(r.width && r.height && style.display !== 'none' && style.visibility !== 'hidden');
}

function candidates(node) {
    var found = {}, out = [];
    if (!node || node.nodeType !== 1) return out;
    var links = node.querySelectorAll ? node.querySelectorAll('a') : [];
    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        var id = '';
        try {
            var u = new URL(href, location.href);
            id = u.searchParams.get('XID') || u.searchParams.get('userID') || '';
        } catch (e) {}
        if (!id) {
            var match = href.match(/(?:XID|userID)=(\d+)/i);
            if (match) id = match[1];
        }
        if (id) {
            var byId = rows.find(function (x) { return x.id === String(id); });
            if (byId) found[byId.id] = byId;
        }
    }
    ['data-user-id','data-userid','data-id'].forEach(function (attr) {
        var id = node.getAttribute && node.getAttribute(attr);
        if (!id) return;
        var byId = rows.find(function (x) { return x.id === String(id); });
        if (byId) found[byId.id] = byId;
    });
    if (!Object.keys(found).length) {
        var text = (node.textContent || '').toLowerCase();
        rows.forEach(function (x) {
            var name = String(x.name || '').trim().toLowerCase();
            if (name && text.indexOf(name) >= 0) found[x.id] = x;
        });
    }
    Object.keys(found).forEach(function (id) { out.push(found[id]); });
    return out;
}

function employeeFromNode(target) {
    if (!target || !rows.length) return null;
    var node = target.nodeType === 1 ? target : target.parentElement;
    for (var depth = 0; node && node !== document.body && depth < 9; depth++, node = node.parentElement) {
        if (node.tagName === 'FORM') return null;
        var list = candidates(node);
        if (list.length === 1) return list[0];
        if (list.length > 1) return null;
    }
    return null;
}

function payInput(input) {
    if (!input || input.tagName !== 'INPUT' || !visible(input) || input.disabled || input.readOnly) return false;
    if (!/^(number|text|tel)$/.test((input.type || 'text').toLowerCase())) return false;
    var meta = [input.name,input.id,input.placeholder,input.getAttribute('aria-label'),input.className].join(' ').toLowerCase();
    if (/wage|salary|pay/.test(meta)) return true;
    return !!employeeFromNode(input);
}

function nativeSet(input, value) {
    var p = input, descriptor = null;
    while (p && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(p, 'value');
        p = Object.getPrototypeOf(p);
    }
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
}

function fillInput(input, employee) {
    if (!cfg.fill || !input || !employee || employee.omit) return false;
    var value = String(Math.trunc(num(employee.suggested)));
    function apply() {
        try { input.step = '1'; } catch (e) {}
        nativeSet(input, value);
        input.dataset.gbEmployee = employee.id;
        try { input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value })); }
        catch (e) { input.dispatchEvent(new Event('input', { bubbles:true })); }
        input.dispatchEvent(new Event('change', { bubbles:true }));
    }
    try { input.focus({ preventScroll:true }); } catch (e) { try { input.focus(); } catch (_) {} }
    apply();
    setTimeout(apply, 80);
    setTimeout(apply, 220);
    toast('Filled ' + employee.name + ': ' + money(employee.suggested), true);
    return true;
}

function clearPending() { pendingId = ''; pendingUntil = 0; }
function remember(target) {
    var x = employeeFromNode(target);
    if (x) { pendingId = x.id; pendingUntil = Date.now() + 1600; return x; }
    return null;
}
function pending() {
    if (!pendingId || Date.now() > pendingUntil) { clearPending(); return null; }
    return rows.find(function (x) { return x.id === pendingId; }) || null;
}
function handleTarget(target) {
    if (!isOwnCompanyView() || !cfg.fill || !rows.length) return;
    var input = target && target.closest ? target.closest('input') : null;
    if (input && payInput(input)) {
        var direct = employeeFromNode(input);
        if (direct) { clearPending(); fillInput(input, direct); return; }
        var p = pending();
        if (p) { clearPending(); fillInput(input, p); return; }
    }
    remember(target);
}

document.addEventListener('pointerdown', function (e) { handleTarget(e.target); }, true);
document.addEventListener('click', function (e) { handleTarget(e.target); }, true);
document.addEventListener('focusin', function (e) {
    var input = e.target;
    if (!isOwnCompanyView() || !cfg.fill || !input || input.tagName !== 'INPUT' || !payInput(input)) return;
    var x = employeeFromNode(input) || pending();
    if (x) { clearPending(); fillInput(input, x); }
}, true);

new MutationObserver(function (mutations) {
    if (!isOwnCompanyView() || !cfg.fill || !pendingId) return;
    var x = pending();
    if (!x) return;
    for (var m = 0; m < mutations.length; m++) {
        var nodes = mutations[m].addedNodes || [];
        for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j], inputs = [];
            if (node.nodeType === 1) {
                if (node.tagName === 'INPUT') inputs = [node];
                else if (node.querySelectorAll) inputs = Array.from(node.querySelectorAll('input'));
            }
            for (var k = 0; k < inputs.length; k++) {
                if (payInput(inputs[k]) && !employeeFromNode(inputs[k])) {
                    clearPending();
                    fillInput(inputs[k], x);
                    return;
                }
            }
        }
    }
}).observe(document.documentElement, { childList:true, subtree:true });

function dragButton(button) {
    var saved = get('pos', null);
    var drag = null;
    var moved = false;

    function place(x, y) {
        x = Math.max(8, Math.min(innerWidth - button.offsetWidth - 8, num(x)));
        y = Math.max(8, Math.min(innerHeight - button.offsetHeight - 8, num(y)));
        button.style.left = x + 'px';
        button.style.top = y + 'px';
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        return { x:x, y:y };
    }

    requestAnimationFrame(function () {
        if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) place(saved.x, saved.y);
        else remove('pos');
    });
    button.onpointerdown = function (e) {
        var r = button.getBoundingClientRect();
        drag = { id:e.pointerId, dx:e.clientX-r.left, dy:e.clientY-r.top, sx:e.clientX, sy:e.clientY };
        moved = false;
        try { button.setPointerCapture(e.pointerId); } catch (_) {}
    };
    button.onpointermove = function (e) {
        if (!drag || drag.id !== e.pointerId) return;
        if (Math.abs(e.clientX-drag.sx) > 4 || Math.abs(e.clientY-drag.sy) > 4) moved = true;
        if (moved) { e.preventDefault(); place(e.clientX-drag.dx, e.clientY-drag.dy); }
    };
    button.onpointerup = function () {
        if (!drag) return;
        var r = button.getBoundingClientRect();
        put('pos', place(r.left, r.top));
        drag = null;
        if (!moved) openPanel();
    };
}

var old = document.getElementById(ID);
if (old) old.remove();

var oldLauncher = document.getElementById('tch-company-helper-fab');
if (oldLauncher) oldLauncher.remove();

var host = document.createElement('div');
host.id = ID;
host.style.setProperty('display', 'block', 'important');
host.style.setProperty('visibility', 'visible', 'important');
host.style.setProperty('opacity', '1', 'important');
document.documentElement.appendChild(host);
var S = host.attachShadow({ mode:'open' });

S.innerHTML = '<style>' +
':host{all:initial;--bg:#111417;--panel:#171b1f;--panel2:#1d2329;--panel3:#242b32;--border:#37414a;--border2:#4a5661;--text:#f3f6f8;--muted:#9ba8b3;--green:#22c77a;--green2:#0d6c47;--red:#ff6b6b;--amber:#f2b84b;--blue:#76c7ff;font-family:Inter,Arial,sans-serif;color:var(--text)}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}#fab{position:fixed;right:14px;bottom:100px;width:50px;height:50px;border-radius:16px;border:1px solid #5ccf94;background:linear-gradient(145deg,#0b6a45,#0a5037);color:#fff;z-index:2147483645;box-shadow:0 10px 25px #0008;font-weight:900;font-size:13px;letter-spacing:.4px;touch-action:none}#fab::after{content:"$";position:absolute;right:-5px;top:-6px;width:19px;height:19px;border-radius:50%;display:grid;place-items:center;background:#e9fff4;color:#075535;font-size:12px;border:2px solid #075535}#overlay{display:none;position:fixed;inset:0;background:#080a0ccc;z-index:2147483646;overflow:auto;color:var(--text);-webkit-text-fill-color:initial}#overlay.show{display:block}#panel{width:min(1380px,calc(100vw - 20px));min-height:calc(100vh - 20px);margin:10px auto;background:var(--bg);border:1px solid var(--border2);border-radius:16px;overflow:hidden;box-shadow:0 24px 70px #000b}header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:#0b0e11eF;border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}.brand{display:flex;align-items:center;gap:11px;min-width:0}.logo{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:#0b6a45;border:1px solid #42c889;color:white;font-weight:900}.brand h2{margin:0;font-size:16px;line-height:1.2;color:var(--text)}.brand h2 span{color:var(--muted);font-size:11px;font-weight:700}.brand p{margin:3px 0 0;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw}.header-actions{display:flex;align-items:center;gap:9px}.refresh-state{font-size:11px;color:#a9e6c8}.refresh-state.stale{color:var(--amber)}.icon-btn{width:34px;height:34px;padding:0;border-radius:9px;border:1px solid var(--border2);background:var(--panel2);color:#fff!important;font-size:20px}.actionbar{display:flex;gap:7px;flex-wrap:wrap;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--border)}.actionbar button,.settings button,.empty button,.toolbar button{border:1px solid var(--border2);border-radius:9px;padding:8px 11px;background:var(--panel3);color:var(--text)!important;font-weight:750}.actionbar .primary,.empty .primary{background:var(--green2);border-color:#2f9d70}.spinner{display:inline-block;width:12px;height:12px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:5px}@keyframes spin{to{transform:rotate(360deg)}}.settings{padding:14px;background:#14191e;border-bottom:1px solid var(--border)}.section-title{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:12px}.section-title h3{margin:0;font-size:15px}.section-title p{margin:3px 0 0;color:var(--muted);font-size:11px}.text-btn{padding:5px 8px!important;background:transparent!important;color:var(--blue)!important}.settings-grid{display:grid;grid-template-columns:repeat(3,minmax(190px,1fr));gap:10px}.setting{display:block;padding:10px;border:1px solid var(--border);background:var(--panel);border-radius:10px}.setting>span{display:block;font-size:12px;font-weight:800;margin-bottom:6px}.setting input,.setting select{width:100%;height:36px;padding:7px 9px;border:1px solid #5a6570;border-radius:7px;background:#f8fafb!important;color:#101417!important;-webkit-text-fill-color:#101417!important}.setting small{display:block;color:var(--muted);font-size:10px;line-height:1.35;margin-top:6px}.toggles{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:8px;margin-top:10px}.toggle{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--panel);cursor:pointer}.toggle input{position:absolute;opacity:0}.switch{width:36px;height:20px;border-radius:999px;background:#4a535c;position:relative;flex:0 0 auto}.switch::after{content:"";position:absolute;width:14px;height:14px;top:3px;left:3px;border-radius:50%;background:white;transition:.15s}.toggle input:checked+.switch{background:var(--green2)}.toggle input:checked+.switch::after{left:19px}.toggle b,.toggle small{display:block}.toggle b{font-size:12px}.toggle small{margin-top:2px;color:var(--muted);font-size:10px;line-height:1.35}.error-card{display:grid;grid-template-columns:34px 1fr 28px;gap:10px;align-items:start;margin:12px 14px;padding:11px;border:1px solid #9d4b4b;background:#3d1c1f;border-radius:11px}.error-icon{width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:#7d2e34;font-weight:900}.error-card b{font-size:12px}.error-card p{margin:4px 0;font-size:11px;color:#ffd9d9}.error-card small{font-size:10px;line-height:1.4;color:#ffd9d9}.error-card>button{border:0;background:transparent;color:#fff;font-size:18px}.error-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.error-actions button,.error-actions a{display:inline-flex;align-items:center;padding:6px 8px;border-radius:7px;border:1px solid #a45d5d;background:#582a2d;color:#fff!important;text-decoration:none;font-size:10px;font-weight:800}.error-actions a{background:#272f36;border-color:#596672}.notice{margin:0 14px 10px;padding:9px 11px;background:#3b321b;border:1px solid #806b2f;border-radius:9px;color:#ffe3a0;font-size:11px}.empty{min-height:55vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px}.empty-icon{width:60px;height:60px;border-radius:18px;display:grid;place-items:center;background:#0f6546;border:1px solid #42b982;font-size:28px;font-weight:900}.empty h3{margin:14px 0 5px;font-size:18px}.empty p{max-width:520px;margin:0 0 14px;color:var(--muted);font-size:12px;line-height:1.55}.empty>div{display:flex;gap:8px}.summary{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:8px;padding:12px 14px}.summary-card{padding:11px;border:1px solid var(--border);border-radius:11px;background:linear-gradient(180deg,var(--panel2),var(--panel));min-width:0}.summary-card small,.summary-card b,.summary-card span{display:block}.summary-card small{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.45px}.summary-card b{margin-top:4px;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary-card span{margin-top:4px;color:var(--muted);font-size:10px}.summary-card.good b{color:#8ff0bd}.summary-card.warn b{color:#ffd27d}.workspace{padding:0 14px 16px}.toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 8px}.search{flex:1 1 290px;display:flex;align-items:center;gap:6px;height:38px;padding:0 10px;border:1px solid var(--border2);border-radius:9px;background:var(--panel)}.search span{color:var(--muted);font-size:18px}.search input{width:100%;border:0;outline:0;background:transparent!important;color:var(--text)!important;-webkit-text-fill-color:var(--text)!important}.toolbar select{height:38px;padding:0 9px;border:1px solid var(--border2);border-radius:9px;background:var(--panel3)!important;color:var(--text)!important;-webkit-text-fill-color:var(--text)!important}.toolbar .small{height:38px}.filters{display:flex;gap:6px;overflow-x:auto;padding-bottom:3px}.filter{display:flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;border:1px solid var(--border);background:var(--panel);color:var(--muted);white-space:nowrap}.filter span{min-width:20px;padding:2px 5px;border-radius:999px;background:#2c343c;font-size:9px;text-align:center}.filter.active{background:#123829;border-color:#2e8b64;color:#bdf4d6}.table-meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:10px;padding:7px 2px}.table-wrap{width:100%;overflow:auto;border:1px solid var(--border);border-radius:11px;background:var(--panel);-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;max-height:62vh}.table-wrap::-webkit-scrollbar{height:10px;width:10px}.table-wrap::-webkit-scrollbar-thumb{background:#55616c;border:2px solid #1a2026;border-radius:99px}.table-wrap::-webkit-scrollbar-track{background:#1a2026}table{width:max-content;min-width:1320px;border-collapse:separate;border-spacing:0;font-size:11px}th,td{padding:8px 9px;border-bottom:1px solid #303840;white-space:nowrap;text-align:right;background:var(--panel);color:var(--text)!important}th{position:sticky;top:0;z-index:6;background:#0c1013!important;color:#cbd4db!important;font-size:9px;text-transform:uppercase;letter-spacing:.35px}tbody tr:nth-child(even) td{background:#151a1f}.sticky-check{position:sticky;left:0;z-index:8!important;width:46px;min-width:46px;text-align:center!important}.sticky-name{position:sticky;left:46px;z-index:7!important;width:165px;min-width:165px;text-align:left!important;border-right:1px solid var(--border2);box-shadow:7px 0 12px -12px #000}thead .sticky-check,thead .sticky-name{z-index:10!important;background:#0c1013!important}.excluded-row td{opacity:.62}.employee-link{padding:0;border:0;background:transparent;color:#9bd8ff!important;font-weight:850;text-align:left}.sticky-name small{display:block;margin-top:2px;color:var(--muted);font-size:9px}.cell-note{display:block;margin-top:2px;color:var(--muted);font-size:9px;font-weight:500}.cell-note.attention{color:#ffd27d}.fit-cell .arrow{color:var(--muted);padding:0 2px}.suggested b{color:#b8f5d2}.positive{color:#8ff0bd!important}.negative{color:#ff9d9d!important}.tag{display:inline-flex;align-items:center;padding:3px 6px;border-radius:999px;font-size:9px;font-weight:800}.tag.raise{background:#123d2d;color:#9cf0c1}.tag.cut{background:#4a2226;color:#ffb1b1}.tag.keep{background:#293239;color:#ccd5dc}.tag.muted{background:#2b2e31;color:#9da6ad}.row-action{width:28px;height:28px;padding:0;border-radius:7px;border:1px solid var(--border);background:#262e35;color:#fff!important}.subtle{color:var(--muted)}.no-results{text-align:center!important;padding:28px!important;color:var(--muted)!important}footer{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--border);color:var(--muted);font-size:9px;background:#0f1316}.detail-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:14px;background:#050607cc}.detail-shell{width:min(680px,100%);max-height:90vh;overflow:auto}.detail-card{border:1px solid var(--border2);border-radius:14px;background:#14191e;box-shadow:0 20px 60px #000c;padding:14px}.detail-head{display:flex;justify-content:space-between;gap:10px}.detail-head small{color:var(--muted);font-size:10px;text-transform:uppercase}.detail-head h3{margin:3px 0 0;font-size:18px}.detail-head h3 span{color:var(--muted);font-size:11px}.detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:12px}.detail-grid>div{padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}.detail-grid small,.detail-grid b{display:block}.detail-grid small{color:var(--muted);font-size:9px}.detail-grid b{margin-top:3px;font-size:13px}.detail-card h4{margin:14px 0 7px;font-size:11px;text-transform:uppercase;color:#c6d1d9}.breakdown{display:grid;grid-template-columns:repeat(2,1fr);gap:5px}.breakdown>div{display:flex;justify-content:space-between;padding:7px 8px;border-radius:8px;background:var(--panel);font-size:10px}.breakdown .pos{color:#9cf0c1}.breakdown .neg{color:#ff9d9d}.position-box{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px;border:1px solid #35694f;background:#123024;border-radius:9px}.position-box b,.position-box small{display:block}.position-box small{margin-top:3px;color:#a9c7b9;font-size:9px}.position-box strong{font-size:20px;color:#baf2d2}.requirements{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;font-size:9px;color:var(--muted)}.requirements b{padding:3px 6px;border-radius:6px;background:#252e35;color:#dce4e9}.detail-note{margin:12px 0 0;color:var(--muted);font-size:9px;line-height:1.45}#keybox{display:none;position:fixed;inset:0;z-index:2147483647;background:#050607dd;align-items:center;justify-content:center;padding:14px}#keybox.show{display:flex}.key-card{width:min(460px,100%);padding:15px;border:1px solid var(--border2);border-radius:14px;background:#151a1f;color:var(--text)}.key-card h3{margin:0;font-size:16px}.key-card p{margin:5px 0 10px;color:var(--muted);font-size:10px;line-height:1.45}.key-card input[type=password]{width:100%;height:39px;padding:8px 10px;border:1px solid #6a7580;border-radius:8px;background:#fff!important;color:#111!important;-webkit-text-fill-color:#111!important}.remember{display:flex;align-items:center;gap:7px;margin-top:9px;color:#d3dce3;font-size:10px}.key-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:12px;flex-wrap:wrap}.key-actions button{padding:8px 10px;border-radius:8px;border:1px solid var(--border2);background:var(--panel3);color:#fff!important;font-weight:800}.key-actions .save{background:var(--green2)}#toast{position:fixed;left:50%;bottom:28px;z-index:2147483647;transform:translate(-50%,18px);opacity:0;pointer-events:none;padding:9px 12px;border-radius:9px;color:#fff;font:800 11px Arial;box-shadow:0 8px 25px #000b;transition:.18s}#toast.show{opacity:1;transform:translate(-50%,0)}#toast.ok{background:#0b6947}#toast.bad{background:#7d2e34}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #82d9ff;outline-offset:2px}@media(max-width:1000px){.summary{grid-template-columns:repeat(3,1fr)}.settings-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){#panel{width:100vw;min-height:100vh;margin:0;border-radius:0;border-left:0;border-right:0}.brand p{max-width:55vw}.refresh-state{display:none}.summary{grid-template-columns:repeat(2,1fr);padding:10px}.summary-card b{font-size:15px}.workspace{padding:0 8px 12px}.settings-grid,.toggles{grid-template-columns:1fr}.table-wrap{max-height:66vh}.table-meta span:last-child{display:none}.detail-grid{grid-template-columns:repeat(2,1fr)}footer{flex-direction:column}.actionbar{padding:8px}.actionbar button{flex:1 1 auto}.sticky-name{width:145px;min-width:145px}.section-title{align-items:center}}@media(max-width:420px){.summary{grid-template-columns:1fr 1fr}.breakdown{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr 1fr}}' +
'</style>' +
'<div id="overlay"><div id="panel"></div></div>' +
'<div id="keybox"><div class="key-card"><h3>Torn API Key</h3><p data-k="status"></p><input type="password" autocomplete="off" placeholder="Paste Torn API key"><label class="remember"><input type="checkbox" data-k="remember"> Remember on this device (stored in local storage on this device)</label><div class="key-actions"><button data-k="clear">Clear manual key</button><button data-k="cancel">Cancel</button><button data-k="save" class="save">Save key</button></div></div></div>' +
'<div id="toast" role="status" aria-live="polite"></div>';

S.querySelector('#overlay').addEventListener('click', function (e) { if (e.target.id === 'overlay') closePanel(); });
S.querySelector('#keybox [data-k="cancel"]').onclick = function () { S.querySelector('#keybox').classList.remove('show'); };
S.querySelector('#keybox [data-k="save"]').onclick = saveKey;
S.querySelector('#keybox [data-k="clear"]').onclick = clearKey;
S.querySelector('#keybox input[type="password"]').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveKey(); });
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (S.querySelector('#keybox').classList.contains('show')) S.querySelector('#keybox').classList.remove('show');
    else if (detailId) { detailId = ''; render(); }
    else if (S.querySelector('#overlay').classList.contains('show')) closePanel();
});

var launcher = document.createElement('button');
launcher.id = 'tch-company-helper-fab';
launcher.type = 'button';
launcher.setAttribute('aria-label', 'Open Torn Company Helper');
launcher.title = 'Torn Company Helper';
launcher.textContent = 'TC';
launcher.style.cssText = [
    'all:initial',
    'position:fixed',
    'right:14px',
    'bottom:100px',
    'width:52px',
    'height:52px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border-radius:16px',
    'border:2px solid #5ccf94',
    'background:#0a5c3f',
    'color:#ffffff',
    'font:900 13px Arial,sans-serif',
    'letter-spacing:.4px',
    'box-shadow:0 10px 25px rgba(0,0,0,.55)',
    'cursor:pointer',
    'touch-action:none',
    'user-select:none',
    '-webkit-user-select:none',
    'visibility:visible',
    'opacity:1',
    'pointer-events:auto'
].join(';');
launcher.style.setProperty('position', 'fixed', 'important');
launcher.style.setProperty('display', 'flex', 'important');
launcher.style.setProperty('z-index', '2147483647', 'important');
launcher.style.setProperty('visibility', 'visible', 'important');
launcher.style.setProperty('opacity', '1', 'important');
launcher.style.setProperty('pointer-events', 'auto', 'important');

var launcherBadge = document.createElement('span');
launcherBadge.textContent = '$';
launcherBadge.setAttribute('aria-hidden', 'true');
launcherBadge.style.cssText = 'position:absolute;right:-6px;top:-7px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#e9fff4;color:#075535;font:900 12px Arial,sans-serif;border:2px solid #075535;box-sizing:border-box;';
launcher.appendChild(launcherBadge);
document.documentElement.appendChild(launcher);
try { console.log('[Torn Company Helper] launcher mounted'); } catch (e) {}

dragButton(launcher);
restoreCache();

// Torn can replace large portions of the company page without a full reload.
// Keep both the panel host and the launcher mounted at the document root.
var launcherSurvivalObserver = new MutationObserver(function () {
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (!launcher.isConnected) document.documentElement.appendChild(launcher);
});
launcherSurvivalObserver.observe(document.documentElement, { childList:true });

}());