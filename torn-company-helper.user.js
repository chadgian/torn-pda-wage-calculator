// ==UserScript==
// @name         Torn Company Helper
// @namespace    wyn.torn.company.tools
// @version      2.6.1
// @description  Torn company helper for wages, staffing, and historical company changes.
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

var VERSION = '2.6.1';
try { console.log('[Torn Company Helper] v' + VERSION + ' starting'); } catch (e) {}
var ID = 'gb-wage-v240';
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
    protectSupportRoles: true,
    protectRoleCoverage: true,
    exploreNewRoles: true,
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
var ui = { page: 'dashboard', query: '', filter: 'all', sort: 'score', direction: 'desc' };
var pendingId = '';
var pendingUntil = 0;
var changeRange = String(get('changeRange', '7'));
var changesError = '';
// Auto-recording only runs on a visible "Your company" view with a valid key.
var AUTO_SYNC_INTERVAL = 5 * 60000;
var AUTO_SYNC_VISIT_GAP = 90000;
var AUTO_SYNC_CHANGE_GAP = 45000;
var AUTO_SYNC_FAILURE_BACKOFF = 5 * 60000;
var AUTO_SYNC_LEASE_MS = 90000;
var autoSyncTimer = 0;
var autoSyncOwner = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
var autoSyncRoute = '';

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
        weeklyIncome: num(p.income && p.income.weekly),
        dailyCustomers: p.customers && p.customers.daily != null ? num(p.customers.daily) : null,
        weeklyCustomers: p.customers && p.customers.weekly != null ? num(p.customers.weekly) : null,
        efficiency: p.efficiency == null ? null : num(p.efficiency),
        popularity: p.popularity == null ? null : num(p.popularity),
        environment: p.environment == null ? null : num(p.environment),
        funds: p.funds == null ? null : num(p.funds),
        trains: p.trains == null ? null : num(p.trains),
        advertisementBudget: p.advertisement_budget == null ? null : num(p.advertisement_budget),
        value: p.value == null ? null : num(p.value)
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
            ability: String(p.ability || p.special_ability || p.specialAbility || ''),
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

function individualBestPosition(employee) {
    if (!positions.length || employee.director) return null;
    var ranked = positions.map(function (p) { return { position: p, fit: positionFit(employee, p) }; });
    ranked.sort(function (a, b) { return b.fit - a.fit || a.position.name.localeCompare(b.position.name); });
    return ranked[0] || null;
}

var POSITION_STABILITY_BONUS = 2;

// Many Torn positions provide bonuses outside their own work-stat fit.
// The official company catalog normally prefixes descriptions with their role
// family (e.g. "Manager.", "Marketer.", "Trainer."). Check that BEFORE names:
// "Marketing Manager" can be a Marketer rather than a Manager.
function supportRoleKind(position) {
    if (!position) return '';
    var ability = String(position.ability || position.special_ability || position.specialAbility || '').trim().toLowerCase();
    if (/^(manager|marketer|trainer|cleaner|secretary)$/.test(ability)) return ability;
    // Catalog ability is authoritative; a declared non-support ability wins over a
    // misleading job title (e.g. a generic production supervisor).
    if (ability && ability !== 'none') return '';
    var description = String(position.description || '').trim();
    var prefix = description.match(/^(manager|marketer|trainer|cleaner|secretary)\s*[:.\-]/i);
    if (prefix) return prefix[1].toLowerCase();
    var name = String(position.name || '').trim();
    if (/\b(?:marketer|marketing\s+manager|marketing\s+officer)\b/i.test(name)) return 'marketer';
    if (/\b(?:trainer|hr\s+officer)\b/i.test(name)) return 'trainer';
    if (/\b(?:manager|supervisor)\b/i.test(name)) return 'manager';
    if (/\b(?:cleaner|janitor)\b/i.test(name)) return 'cleaner';
    if (/\b(?:secretary|receptionist|bookkeeper)\b/i.test(name)) return 'secretary';
    return '';
}

// This is an observed contribution read from Torn; it is NOT a forecast of
// the bonus after moving either Manager or their colleagues.
function supportRoleSnapshot() {
    var counts = {};
    var managementTotal = 0;
    var managementRecipients = 0;
    var managementReported = 0;
    staff.forEach(function (employee) {
        if (employee.director) return;
        var kind = supportRoleKind(currentPosition(employee)) ||
            supportRoleKind({ name: employee.position });
        if (kind) counts[kind] = (counts[kind] || 0) + 1;
        var value = employee.effectiveness && employee.effectiveness.management;
        if (value == null) return;
        managementReported++;
        if (num(value) > 0) {
            managementTotal += num(value);
            managementRecipients++;
        }
    });
    return {
        counts: counts, managementTotal: managementTotal,
        managementRecipients: managementRecipients,
        managementReported: managementReported
    };
}

function positionKey(position) {
    if (!position) return '';
    return String(position.id || position.name || '');
}

function positionNameKey(value) {
    var name = typeof value === 'string' ? value : value && value.name;
    return String(name || '').trim().toLowerCase();
}

function snapshotPositionCounts(snapshot) {
    var counts = {};
    (snapshot && snapshot.staff || []).forEach(function (employee) {
        var name = String(employee && employee.position || '').trim();
        if (!name || /^director$/i.test(name)) return;
        var key = name.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

function currentNamedPositionCounts() {
    var counts = {};
    staff.forEach(function (employee) {
        if (employee.director) return;
        var current = currentPosition(employee);
        var key = positionNameKey(current || employee.position);
        if (key) counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

// Automatic suggestions use a role-coverage floor. Torn does not expose a
// complete profit formula for every operating position, so eliminating the
// last Administrator, Technician, Cashier, etc. merely because another role
// has a better work-stat score is unsafe. Special support roles are already
// handled separately; this floor protects ordinary operating coverage.
function autoRoleCoverageFloor(position) {
    if (cfg.protectRoleCoverage === false) return 0;
    var current = currentStaffingCounts();
    return num(current[positionKey(position)]) > 0 ? 1 : 0;
}

// Look for a recently removed role whose absence coincides with a material
// daily-income decline. This is correlation, not proof, so it is used as a
// recovery warning / prioritization signal rather than a profit forecast.
function roleHistoryRecoverySignals() {
    var out = {};
    if (!company || !company.id || !positions.length || !staff.length) return out;
    var history = readChangeHistory(company.id);
    var now = lastLoadedAt || Date.now();
    var current = reportSnapshot(company, staff, now);
    var currentCounts = snapshotPositionCounts(current);
    var currentIncome = num(current.company && current.company.dailyIncome);
    var currentEmployees = num(current.company && current.company.employeeCount) || (current.staff || []).length;
    var currentAds = num(current.company && current.company.advertisementBudget);
    var cutoff = now - 14 * 86400000;
    var snapshots = (history.snapshots || []).filter(function (snapshot) {
        return snapshot && snapshot.ts >= cutoff && snapshot.ts < now - 1000 &&
            snapshot.company && Array.isArray(snapshot.staff);
    }).sort(function (a, b) { return a.ts - b.ts; });

    positions.forEach(function (position) {
        var nameKey = positionNameKey(position);
        if (!nameKey || num(currentCounts[nameKey]) > 0) return;
        var withRole = snapshots.filter(function (snapshot) {
            return num(snapshotPositionCounts(snapshot)[nameKey]) > 0;
        });
        if (!withRole.length) return;
        var baseline = withRole[withRole.length - 1];
        var baselineIncome = num(baseline.company.dailyIncome);
        if (!(baselineIncome > 0) || !(currentIncome >= 0)) return;
        var declinePct = (baselineIncome - currentIncome) / baselineIncome * 100;
        var baselineEmployees = num(baseline.company.employeeCount) || (baseline.staff || []).length;
        var baselineAds = num(baseline.company.advertisementBudget);
        var sameHeadcount = baselineEmployees === currentEmployees;
        var adChangePct = baselineAds > 0 ? Math.abs(currentAds - baselineAds) / baselineAds * 100 :
            (currentAds === baselineAds ? 0 : 100);
        // Require a meaningful decline. Same headcount strengthens the signal;
        // a very large decline is still surfaced even if another roster change occurred.
        if (!(declinePct >= 20 && sameHeadcount) && declinePct < 35) return;

        var beforeCounts = snapshotPositionCounts(baseline);
        var increasedKeys = [];
        positions.forEach(function (candidate) {
            var candidateName = positionNameKey(candidate);
            if (num(currentCounts[candidateName]) > num(beforeCounts[candidateName])) {
                increasedKeys.push(positionKey(candidate));
            }
        });

        out[positionKey(position)] = {
            position: position.name,
            removedAfter: baseline.ts,
            baselineIncome: baselineIncome,
            currentIncome: currentIncome,
            declinePct: declinePct,
            sameHeadcount: sameHeadcount,
            adChangePct: adChangePct,
            increasedKeys: increasedKeys,
            strong: declinePct >= 35 || (declinePct >= 20 && sameHeadcount && adChangePct <= 25)
        };
    });
    return out;
}

function samePosition(employee, position) {
    var current = currentPosition(employee);
    return !!(current && position && positionKey(current) === positionKey(position));
}

function currentStaffingCounts() {
    var counts = {};
    staff.forEach(function (employee) {
        if (employee.director) return;
        var p = currentPosition(employee);
        if (!p) {
            var fallback = individualBestPosition(employee);
            p = fallback && fallback.position;
        }
        if (!p) return;
        var key = positionKey(p);
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

function staffingPlanStorageKey() {
    if (!company) return '';
    return String(company.id || ('type-' + company.typeId));
}

function normalizedStaffingPlan(raw) {
    var out = {};
    positions.forEach(function (p) {
        out[positionKey(p)] = Math.max(0, Math.round(num(raw && raw[positionKey(p)])));
    });
    return out;
}

function staffingPlanInfo() {
    var current = currentStaffingCounts();
    var store = get('staffingPlans', {});
    var storageKey = staffingPlanStorageKey();
    var saved = storageKey && store && store[storageKey] ? normalizedStaffingPlan(store[storageKey]) : null;
    var target = saved || normalizedStaffingPlan(current);
    var employeeTotal = staff.filter(function (x) { return !x.director; }).length;
    var targetTotal = positions.reduce(function (t, p) { return t + num(target[positionKey(p)]); }, 0);
    var currentTotal = positions.reduce(function (t, p) { return t + num(current[positionKey(p)]); }, 0);
    var valid = targetTotal === employeeTotal;
    var coverageWarnings = [];
    if (valid && saved && cfg.protectRoleCoverage !== false) {
        positions.forEach(function (position) {
            var key = positionKey(position);
            if (num(current[key]) > 0 && num(target[key]) <= 0) coverageWarnings.push(position.name);
        });
    }
    var safe = valid && coverageWarnings.length === 0;
    var effective = safe ? target : normalizedStaffingPlan(current);

    return {
        current: current,
        target: target,
        effective: effective,
        employeeTotal: employeeTotal,
        targetTotal: targetTotal,
        currentTotal: currentTotal,
        valid: valid,
        safe: safe,
        coverageWarnings: coverageWarnings,
        custom: !!saved,
        customApplied: !!saved && safe
    };
}

function saveStaffingTarget(key, value) {
    if (!company || !key) return;
    var storageKey = staffingPlanStorageKey();
    var store = get('staffingPlans', {});
    var existing = store[storageKey] ? normalizedStaffingPlan(store[storageKey]) : normalizedStaffingPlan(currentStaffingCounts());
    existing[key] = Math.max(0, Math.round(num(value)));
    store[storageKey] = existing;
    put('staffingPlans', store);
}

function resetStaffingPlan() {
    var storageKey = staffingPlanStorageKey();
    if (!storageKey) return;
    var store = get('staffingPlans', {});
    delete store[storageKey];
    put('staffingPlans', store);
}

function maxWeightAssignment(matrix) {
    var n = matrix.length;
    if (!n) return [];
    var m = matrix[0].length;
    if (m < n) return [];

    var maxValue = 0;
    matrix.forEach(function (row) {
        row.forEach(function (value) { if (value > maxValue) maxValue = value; });
    });

    var u = new Array(n + 1).fill(0);
    var v = new Array(m + 1).fill(0);
    var p = new Array(m + 1).fill(0);
    var way = new Array(m + 1).fill(0);

    for (var i = 1; i <= n; i++) {
        p[0] = i;
        var j0 = 0;
        var minv = new Array(m + 1).fill(Infinity);
        var used = new Array(m + 1).fill(false);

        do {
            used[j0] = true;
            var i0 = p[j0];
            var delta = Infinity;
            var j1 = 0;

            for (var j = 1; j <= m; j++) {
                if (used[j]) continue;
                var cost = maxValue - num(matrix[i0 - 1][j - 1]);
                var cur = cost - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            for (var k = 0; k <= m; k++) {
                if (used[k]) {
                    u[p[k]] += delta;
                    v[k] -= delta;
                } else {
                    minv[k] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);

        do {
            var prev = way[j0];
            p[j0] = p[prev];
            j0 = prev;
        } while (j0 !== 0);
    }

    var assignment = new Array(n).fill(-1);
    for (var col = 1; col <= m; col++) {
        if (p[col] > 0 && p[col] <= n) assignment[p[col] - 1] = col - 1;
    }
    return assignment;
}

function companyPositionAssignment(overrideTargets) {
    var employees = staff.filter(function (x) { return !x.director; });
    var plan = staffingPlanInfo();
    if (overrideTargets) {
        var alternative = normalizedStaffingPlan(overrideTargets);
        var alternativeTotal = positions.reduce(function (total, p) {
            return total + num(alternative[positionKey(p)]);
        }, 0);
        if (alternativeTotal !== employees.length) return {
            byEmployee:{}, plan:plan, currentFit:0, suggestedFit:0,
            support:supportRoleSnapshot(), protectedCount:0, supportRisks:[], invalid:true
        };
        plan = Object.assign({}, plan, { effective:alternative, target:alternative, valid:true, custom:true });
    }
    var slots = [];
    var support = supportRoleSnapshot();

    positions.forEach(function (p) {
        var count = Math.max(0, Math.round(num(plan.effective[positionKey(p)])));
        for (var i = 0; i < count; i++) slots.push(p);
    });

    if (!employees.length || !positions.length || slots.length !== employees.length) {
        return { byEmployee:{}, plan:plan, currentFit:0, suggestedFit:0,
            support:support, protectedCount:0, supportRisks:[] };
    }

    // Pre-assign existing support-role incumbents to their actual role slots.
    // This preserves *who* is Manager, Marketer, Trainer, Cleaner, etc., not
    // merely the number of such employees. A stat-fit-only optimizer cannot
    // estimate their company-wide effects or revenue consequences.
    var locked = {};
    var reserved = {};
    var protectedCount = 0;
    if (cfg.protectSupportRoles !== false) {
        employees.forEach(function (employee, index) {
            var current = currentPosition(employee);
            if (!supportRoleKind(current)) return;
            for (var i = 0; i < slots.length; i++) {
                if (!reserved[i] && positionKey(slots[i]) === positionKey(current)) {
                    locked[index] = i;
                    reserved[i] = true;
                    protectedCount++;
                    return;
                }
            }
        });
    }

    // Optimization runs only on remaining employees and unreserved slots,
    // so protected support assignments can never be displaced by a better
    // individual Cashier (or other production-role) fit.
    var movable = [];
    var available = [];
    employees.forEach(function (_, index) {
        if (!Object.prototype.hasOwnProperty.call(locked, index)) movable.push(index);
    });
    slots.forEach(function (_, index) { if (!reserved[index]) available.push(index); });
    var matrix = movable.map(function (employeeIndex) {
        var employee = employees[employeeIndex];
        return available.map(function (slotIndex) {
            var position = slots[slotIndex];
            return positionFit(employee, position) +
                (samePosition(employee, position) ? POSITION_STABILITY_BONUS : 0);
        });
    });
    var assignedCols = maxWeightAssignment(matrix);
    var selected = {};
    Object.keys(locked).forEach(function (index) { selected[index] = locked[index]; });
    movable.forEach(function (employeeIndex, rowIndex) {
        var col = assignedCols[rowIndex];
        if (col >= 0 && col < available.length) selected[employeeIndex] = available[col];
    });

    var byEmployee = {};
    var currentFit = 0;
    var suggestedFit = 0;
    var supportRisks = [];

    employees.forEach(function (employee, index) {
        var current = currentPosition(employee);
        var pure = individualBestPosition(employee);
        var slotIndex = selected[index];
        var slot = slotIndex == null ? (current || (pure && pure.position)) : slots[slotIndex];
        var slotFit = slot ? positionFit(employee, slot) : 0;
        var currentPredicted = current ? positionFit(employee, current) : 0;
        var isProtected = Object.prototype.hasOwnProperty.call(locked, index);
        var risk = '';
        if (positionKey(slot) !== positionKey(current) &&
            (supportRoleKind(current) || supportRoleKind(slot))) {
            risk = 'Support-role change: the combined team-wide effect and income are unknown.';
            supportRisks.push({ id: employee.id, name: employee.name,
                from: current ? current.name : employee.position,
                to: slot ? slot.name : 'Unassigned' });
        }

        currentFit += currentPredicted;
        suggestedFit += slotFit;

        byEmployee[employee.id] = {
            position: slot || null,
            fit: slotFit,
            statBestPosition: pure && pure.position || null,
            statBestFit: pure ? pure.fit : 0,
            targetCount: slot ? num(plan.effective[positionKey(slot)]) : 0,
            currentCount: slot ? num(plan.current[positionKey(slot)]) : 0,
            currentPredictedFit: currentPredicted,
            supportProtected: isProtected,
            supportRisk: risk
        };
    });

    return {
        byEmployee: byEmployee,
        plan: plan,
        currentFit: currentFit,
        suggestedFit: suggestedFit,
        support: support,
        protectedCount: protectedCount,
        supportRisks: supportRisks,
        coverageProtectedCount: cfg.protectRoleCoverage === false ? 0 :
            positions.filter(function (position) { return num(plan.current[positionKey(position)]) > 0; }).length,
        coverageWarnings: plan.coverageWarnings || []
    };
}


/*
 * Role opportunities deliberately compare NEW role types, not just incumbents.
 * We never infer company profit from individual stat-fit or assign an unknown
 * future hire's stats. The director reviews possible staffing mixes manually.
 */
function potentialRoleBenefit(position) {
    var kind = supportRoleKind(position);
    var belowTarget = staff.filter(function (e) {
        return !e.director && e.effectiveness && e.effectiveness.total != null &&
            num(e.effectiveness.total) < 100;
    }).length;
    if (kind === 'manager') return {
        reason: 'Managers can reduce lost effectiveness across underperforming employees.' +
            (belowTarget ? ' ' + fmt(belowTarget) + ' current employee(s) report total effectiveness below 100.' : ''),
        signal: belowTarget ? 50 : 28
    };
    if (kind === 'marketer') return {
        reason: 'Marketers improve the effectiveness of company advertising.' +
            (company && num(company.advertisementBudget) > 0 ?
                ' Current advertising budget: ' + money(company.advertisementBudget) + '.' : ''),
        signal: company && num(company.advertisementBudget) > 0 ? 48 : 28
    };
    if (kind === 'cleaner') return {
        reason: 'Cleaners can support the company environment.' +
            (company && company.environment != null ?
                ' Last reported environment: ' + fmt(company.environment) + '.' : ''),
        signal: company && company.environment != null && num(company.environment) < 100 ? 46 : 26
    };
    if (kind === 'trainer') return {
        reason: 'Trainers generate additional company training opportunities based on their effectiveness.',
        signal: 36
    };
    if (kind === 'secretary') return {
        reason: 'Secretaries unlock detailed per-employee earnings data; this improves visibility, not guaranteed revenue.',
        signal: 22
    };
    return {
        reason: String(position.description || '').trim() ||
            'A possible way to redistribute production work among existing employees.',
        signal: 0
    };
}

function suggestAdditionalRoles() {
    if (!cfg.positionAdvice || cfg.exploreNewRoles === false ||
        !company || !positions.length || !staff.length) return [];
    var plan = staffingPlanInfo();
    if (!plan.valid || !plan.safe || plan.employeeTotal < 1) return [];
    var targets = normalizedStaffingPlan(plan.effective);
    var currentSolution = companyPositionAssignment();
    var historySignals = roleHistoryRecoverySignals();
    if (!currentSolution || !Object.keys(currentSolution.byEmployee || {}).length) return [];
    var openCapacity = num(company.capacity) > 0 ?
        Math.max(0, Math.floor(num(company.capacity) - Math.max(staff.length, num(company.employeeCount)))) : 0;
    var roster = staff.filter(function (e) { return !e.director; });
    var activeKinds = {};
    roster.forEach(function (employee) {
        var kind = supportRoleKind(currentPosition(employee));
        if (kind) activeKinds[kind] = true;
    });

    // Never make an existing support role the source of an exploratory slot.
    // Also preserve at least one slot in every currently staffed operating role.
    // A new role may therefore replace a duplicated Cashier/Technician/etc.,
    // but never the company's only Administrator simply because of stat fit.
    var donorPositions = positions.filter(function (p) {
        var key = positionKey(p);
        return !supportRoleKind(p) &&
            num(targets[key]) > autoRoleCoverageFloor(p);
    });
    var offers = [];

    positions.forEach(function (candidate) {
        var targetKey = positionKey(candidate);
        if (!targetKey || num(targets[targetKey]) !== 0) return;
        var kind = supportRoleKind(candidate);
        var historySignal = historySignals[targetKey] || null;
        // Avoid proposing another version of a special ability already staffed.
        if (kind && activeKinds[kind]) return;
        var benefit = potentialRoleBenefit(candidate);
        if (historySignal && historySignal.strong) {
            benefit = {
                reason: 'Recovery signal: this role was recently staffed, and tracked daily income is now ' +
                    pct(historySignal.declinePct, 0) + ' lower than the last recent snapshot that included it. ' +
                    'This is observed correlation, not proof of causation.',
                signal: 120 + Math.min(60, Math.max(0, historySignal.declinePct))
            };
        }
        var strongest = null;

        donorPositions.forEach(function (donor) {
            var donorKey = positionKey(donor);
            var hypothetical = Object.assign({}, targets);
            hypothetical[donorKey] = num(hypothetical[donorKey]) - 1;
            hypothetical[targetKey] = num(hypothetical[targetKey]) + 1;
            var evaluated = companyPositionAssignment(hypothetical);
            if (evaluated.invalid || !Object.keys(evaluated.byEmployee || {}).length) return;

            // The support incumbents must keep exactly their current position.
            if (roster.some(function (employee) {
                var current = currentPosition(employee);
                return supportRoleKind(current) && (!evaluated.byEmployee[employee.id] ||
                    positionKey(evaluated.byEmployee[employee.id].position) !== positionKey(current));
            })) return;

            var delta = evaluated.suggestedFit - currentSolution.suggestedFit;
            var historicalReverse = !!(historySignal &&
                historySignal.increasedKeys.indexOf(donorKey) >= 0);
            var selectionScore = delta + (historicalReverse ? 10000 : 0);
            if (!strongest || selectionScore > strongest.selectionScore ||
                (selectionScore === strongest.selectionScore && donor.name.localeCompare(strongest.replaces) < 0)) {
                strongest = {
                    replaces: donor.name, replacesKey: donorKey, fitDelta: delta,
                    targets: hypothetical, caution: !!kind || !!historySignal ||
                        (evaluated.supportRisks || []).length > 0,
                    historicalReverse: historicalReverse,
                    selectionScore: selectionScore
                };
            }
        });

        // Ordinary unstaffed roles need either a modeled fit improvement or a
        // strong recent recovery signal. If no safe donor exists, keep the role
        // visible as a manual/hiring recovery idea rather than deleting another
        // unique operating role.
        if (!kind && !historySignal && (!strongest || strongest.fitDelta <= 0) && !openCapacity) return;
        if (!strongest && !openCapacity && !(historySignal && historySignal.strong)) return;
        offers.push({
            position: candidate.name, key: targetKey, kind: kind,
            reason: benefit.reason, priority: benefit.signal,
            plan: strongest, openCapacity: openCapacity,
            historySignal: historySignal,
            rank: benefit.signal +
                (historySignal && historySignal.strong ? 100 : 0) +
                (!kind && strongest ? Math.max(0, strongest.fitDelta) : 0)
        });
    });

    offers.sort(function (a, b) {
        return b.rank - a.rank || (b.plan ? 1 : 0) - (a.plan ? 1 : 0) ||
            a.position.localeCompare(b.position);
    });
    return offers.slice(0, 6);
}

// Updates helper-only staffing targets. This never changes Torn company roles.
function useAdditionalRolePlan(roleKey) {
    var offer = suggestAdditionalRoles().find(function (x) { return x.key === String(roleKey); });
    if (!offer || !offer.plan || !company) return false;
    var valid = positions.reduce(function (total, p) {
        return total + num(offer.plan.targets[positionKey(p)]);
    }, 0) === staff.filter(function (x) { return !x.director; }).length;
    if (!valid) return false;
    var saved = get('staffingPlans', {});
    saved[staffingPlanStorageKey()] = normalizedStaffingPlan(offer.plan.targets);
    put('staffingPlans', saved);
    return true;
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
    var positionAssignment = cfg.positionAdvice ? companyPositionAssignment() : { byEmployee:{}, plan:staffingPlanInfo(), currentFit:0, suggestedFit:0 };
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
        var assigned = positionAssignment.byEmployee[employee.id] || null;
        var pure = individualBestPosition(employee);
        return Object.assign({}, employee, {
            score: score,
            currentFit: actualWorkFit,
            predictedCurrentFit: predictedFit,
            bestPosition: assigned && assigned.position || null,
            bestFit: assigned ? assigned.fit : 0,
            statBestPosition: assigned && assigned.statBestPosition || pure && pure.position || null,
            statBestFit: assigned ? assigned.statBestFit : pure ? pure.fit : 0,
            staffingTarget: assigned ? assigned.targetCount : 0,
            staffingCurrent: assigned ? assigned.currentCount : 0,
            supportProtected: !!(assigned && assigned.supportProtected),
            supportRisk: assigned && assigned.supportRisk || ''
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
        var assigned = positionAssignment.byEmployee[employee.id] || null;
        var pure = individualBestPosition(employee);
        return Object.assign({}, employee, {
            score: 0,
            currentFit: employee.effectiveness.working_stats == null ? (currentPos ? positionFit(employee, currentPos) : 0) : num(employee.effectiveness.working_stats),
            predictedCurrentFit: currentPos ? positionFit(employee, currentPos) : 0,
            bestPosition: assigned && assigned.position || null,
            bestFit: assigned ? assigned.fit : 0,
            statBestPosition: assigned && assigned.statBestPosition || pure && pure.position || null,
            statBestFit: assigned ? assigned.statBestFit : pure ? pure.fit : 0,
            staffingTarget: assigned ? assigned.targetCount : 0,
            staffingCurrent: assigned ? assigned.currentCount : 0,
            supportProtected: !!(assigned && assigned.supportProtected),
            supportRisk: assigned && assigned.supportRisk || '',
            suggested: employee.wage == null ? 0 : employee.wage,
            change: 0,
            changePct: 0,
            omit: true
        });
    });

    rows.forEach(function (x) {
        x.omit = !includedMap[x.id];
        x.recommendPosition = !!(cfg.positionAdvice && x.bestPosition && !x.director && x.bestPosition.name !== x.position);
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
        avgFit: avg(calcRows, function (x) { return x.currentFit; }),
        positionPlan: positionAssignment.plan,
        positionCurrentFit: positionAssignment.currentFit,
        positionSuggestedFit: positionAssignment.suggestedFit,
        support: positionAssignment.support || supportRoleSnapshot(),
        protectedCount: positionAssignment.protectedCount || 0,
        supportRisks: positionAssignment.supportRisks || [],
        coverageProtectedCount: positionAssignment.coverageProtectedCount || 0,
        coverageWarnings: positionAssignment.coverageWarnings || []
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
    await updateCompanyChanges(nextCompany, nextStaff);
}


/* Company Changes: store snapshots and the official employee news separately per company.
   All data stays in this browser's localStorage, never in an external service. */
function changeStorageKey(id) { return 'changeHistory:' + String(id); }

function readChangeHistory(id) {
    var raw = get(changeStorageKey(id), null);
    if (!raw || String(raw.companyId) !== String(id)) {
        return { companyId: String(id), snapshots: [], news: [], reasons: {}, lastNewsFetch: 0 };
    }
    return {
        companyId: String(id),
        snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
        news: Array.isArray(raw.news) ? raw.news : [],
        reasons: raw.reasons && typeof raw.reasons === 'object' && !Array.isArray(raw.reasons) ? raw.reasons : {},
        lastNewsFetch: num(raw.lastNewsFetch)
    };
}

function reportSnapshot(c, employees, timestamp) {
    var employeesOnly = employees.filter(function (e) { return !e.director; });
    var withStats = employeesOnly.filter(function (e) {
        return e.effectiveness && e.effectiveness.working_stats != null;
    });
    var withManagement = employeesOnly.filter(function (e) {
        return e.effectiveness && e.effectiveness.management != null;
    });
    return {
        ts: timestamp || Date.now(),
        company: {
            dailyIncome: c.dailyIncome, weeklyIncome: c.weeklyIncome,
            dailyCustomers: c.dailyCustomers, weeklyCustomers: c.weeklyCustomers,
            efficiency: c.efficiency, popularity: c.popularity, environment: c.environment,
            funds: c.funds, trains: c.trains, advertisementBudget: c.advertisementBudget,
            value: c.value, rating: c.rating, employeeCount: c.employeeCount,
            employeeCapacity: c.capacity,
            payroll: sum(employees, function (e) { return e.wage; }),
            avgEffectiveness: employeesOnly.length ? avg(employeesOnly, function (e) {
                return e.effectiveness && e.effectiveness.total;
            }) : null,
            avgWorkingStatEffectiveness: withStats.length ? avg(withStats, function (e) {
                return e.effectiveness.working_stats;
            }) : null,
            managementBonusPoints: withManagement.length ? sum(withManagement, function (e) {
                return e.effectiveness.management;
            }) : null
        },
        staff: employees.map(function (e) {
            return { id: String(e.id), name: e.name, position: e.position,
                wage: e.wage, effectiveness: e.effectiveness && e.effectiveness.total };
        })
    };
}

function plainNewsText(html) {
    var template = document.createElement('template');
    template.innerHTML = String(html == null ? '' : html);
    return String(template.content.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

function newsEventType(text) {
    if (/\b(fired|firing|dismissed|terminated|sacked)\b/i.test(text)) return 'fired';
    if (/\b(left|quit|resigned|departed)\b/i.test(text)) return 'left';
    if (/\b(hired|joined|recruited|employed|started working)\b/i.test(text)) return 'joined';
    if (/\b(promoted|demoted|position changed|moved to)\b/i.test(text)) return 'position';
    return 'other';
}

function reportedFiringReason(text) {
    var value = String(text);
    var match = value.match(/\b(?:reason\s*:\s*|because\s+(?:of\s+)?|due to\s+)([^.;]{3,120})/i) ||
        value.match(/\b(?:fired|dismissed|terminated)\b[^.!]{0,100}\bfor\s+([^.;]{3,120})/i);
    return match ? match[1].trim() : '';
}

function normalizeCompanyNews(payload) {
    var raw = payload && payload.news || [];
    var entries = Array.isArray(raw) ? raw : Object.keys(raw || {}).map(function (id) {
        return Object.assign({ id: id }, raw[id] || {});
    });
    return entries.map(function (entry) {
        var text = plainNewsText(entry.text != null ? entry.text : entry.news);
        var ts = num(entry.timestamp) * 1000;
        return {
            id: String(entry.id || (String(entry.timestamp) + ':' + text)),
            text: text, ts: ts, type: newsEventType(text),
            reason: reportedFiringReason(text)
        };
    }).filter(function (e) { return e.text && e.ts > 0; });
}

// Preserve every observed material update in the recent window. Older history
// is downsampled so daily, weekly and monthly reports remain useful without
// exhausting localStorage. Values are never backfilled for unobserved periods.
function snapshotFingerprint(snapshot) {
    if (!snapshot) return '';
    var roster = (snapshot.staff || []).map(function (e) {
        return { id: String(e.id), name: e.name, position: e.position,
            wage: e.wage, effectiveness: e.effectiveness };
    }).sort(function (a, b) { return a.id.localeCompare(b.id); });
    return JSON.stringify({ company: snapshot.company || {}, staff: roster });
}

function compactCompanySnapshots(snapshots, now) {
    var cutoff = now - 180 * 86400000;
    var recent = [], medium = {}, older = {};
    (snapshots || []).filter(function (s) {
        return s && Number.isFinite(Number(s.ts)) && s.ts >= cutoff && s.ts <= now &&
            Array.isArray(s.staff) && s.company;
    }).sort(function (a,b) { return a.ts - b.ts; }).forEach(function (item) {
        var age = now - item.ts;
        if (age <= 86400000) recent.push(item);
        else if (age <= 14 * 86400000) medium[Math.floor(item.ts / (3 * 3600000))] = item;
        else older[Math.floor(item.ts / 86400000)] = item;
    });
    // Retain up to 180 recent material events plus one observation per 3h
    // for the previous fortnight, then daily observations for older periods.
    return Object.keys(older).map(function(k){return older[k];})
        .concat(Object.keys(medium).map(function(k){return medium[k];}))
        .concat(recent.slice(-180))
        .sort(function(a,b){return a.ts-b.ts;}).slice(-480);
}

async function updateCompanyChanges(c, employees) {
    if (!c || !c.id) { changesError = 'Company ID is unavailable; history cannot be saved.'; return; }
    var store = readChangeHistory(c.id);
    var now = lastLoadedAt || Date.now();
    var cutoff = now - 180 * 86400000;
    store.snapshots = compactCompanySnapshots(store.snapshots, now);
    var newest = store.snapshots[store.snapshots.length - 1];
    var current = reportSnapshot(c, employees, now);
    // Record staff/financial/effectiveness changes as soon as the next
    // successful sync sees them. Keep a heartbeat baseline every 30 minutes
    // when nothing changed. Repeated identical API responses are deduplicated.
    if (!newest || snapshotFingerprint(newest) !== snapshotFingerprint(current) ||
        now - newest.ts >= 1800000) {
        store.snapshots.push(current);
        store.snapshots = compactCompanySnapshots(store.snapshots, now);
    }
    changesError = '';
    if (!store.lastNewsFetch || now - store.lastNewsFetch >= 15 * 60000) {
        try {
            var payload = await api('/company/news?cat=employees&limit=100');
            var merged = {};
            store.news.concat(normalizeCompanyNews(payload)).forEach(function (entry) {
                if (entry && entry.id && entry.ts >= cutoff) merged[String(entry.id)] = entry;
            });
            store.news = Object.keys(merged).map(function (k) { return merged[k]; })
                .sort(function (a, b) { return b.ts - a.ts; }).slice(0, 800);
            store.lastNewsFetch = now;
        } catch (err) {
            changesError = 'Employee news could not be refreshed (' + String(err.message || err) + '). ' +
                'Previous company news and tracked snapshots are still available.';
        }
    }
    put(changeStorageKey(c.id), store);
}

function metricDefinitions() {
    return [
        { key: 'dailyIncome', label: 'Daily income', kind: 'money' },
        { key: 'weeklyIncome', label: 'Weekly income', kind: 'money' },
        { key: 'dailyCustomers', label: 'Daily customers', kind: 'number' },
        { key: 'weeklyCustomers', label: 'Weekly customers', kind: 'number' },
        { key: 'avgEffectiveness', label: 'Avg. employee effectiveness', kind: 'points' },
        { key: 'efficiency', label: 'Company efficiency', kind: 'points' },
        { key: 'popularity', label: 'Popularity', kind: 'points' },
        { key: 'environment', label: 'Environment', kind: 'points' },
        { key: 'payroll', label: 'Daily wage payroll', kind: 'money' },
        { key: 'employeeCount', label: 'Employee count', kind: 'number' },
        { key: 'employeeCapacity', label: 'Employee capacity', kind: 'number' },
        { key: 'avgWorkingStatEffectiveness', label: 'Avg. work-stat effectiveness', kind: 'points' },
        { key: 'managementBonusPoints', label: 'Reported Management bonus total', kind: 'number' },
        { key: 'funds', label: 'Company funds', kind: 'money' },
        { key: 'rating', label: 'Star rating', kind: 'number' },
        { key: 'advertisementBudget', label: 'Advertising budget', kind: 'money' },
        { key: 'trains', label: 'Available trains', kind: 'number' },
        { key: 'value', label: 'Company value', kind: 'money' }
    ];
}

function changePeriodDays() {
    var days = Number(changeRange);
    return [1, 7, 30, 90].indexOf(days) >= 0 ? days : 7;
}

function changeReport() {
    if (!company || !company.id || !staff.length) return null;
    var history = readChangeHistory(company.id);
    var current = reportSnapshot(company, staff, lastLoadedAt || Date.now());
    var start = current.ts - changePeriodDays() * 86400000;
    var sorted = history.snapshots.filter(function (s) { return s && s.ts <= current.ts; })
        .sort(function (a, b) { return a.ts - b.ts; });
    // Prefer a snapshot on/before the requested start. Otherwise, use the first
    // observation inside the period and explicitly mark the period as partial.
    var before = sorted.filter(function (s) { return s.ts <= start; });
    var baseline = before.length ? before[before.length - 1] : sorted.find(function (s) { return s.ts >= start; });
    // A first-time observation is not evidence that nothing has changed.
    if (baseline && baseline.ts >= current.ts - 1000) baseline = null;
    // If an older baseline has a long missing gap, do not silently imply continuous coverage.
    var partial = !baseline || baseline.ts > start ||
        (baseline.ts < start - 86400000);
    var metrics = metricDefinitions().filter(function (m) {
        return baseline && baseline.company && current.company[m.key] != null &&
            baseline.company[m.key] != null;
    }).map(function (m) {
        var previous = Number(baseline.company[m.key]), latest = Number(current.company[m.key]);
        return { key: m.key, label: m.label, kind: m.kind,
            previous: previous, latest: latest, delta: latest - previous };
    });
    var events = history.news.filter(function (e) { return e && e.ts >= start && e.ts <= current.ts &&
        (e.type === 'fired' || e.type === 'left' || e.type === 'joined' || e.type === 'position'); })
        .map(function (e) {
            var note = String(history.reasons[e.id] || '').trim();
            return Object.assign({ source: 'Torn news', reason: note || e.reason,
                reasonSource: note ? 'Director note' : (e.reason ? 'Official news' : '') }, e,
                { reason: note || e.reason });
        });
    // Roster differences between observations are useful fallback evidence, but
    // must never be misrepresented as an official firing or resignation.
    var observations = sorted.filter(function (s) { return s.ts >= start; }).concat([current]);
    if (baseline && observations[0] !== baseline) observations.unshift(baseline);
    for (var i = 1; i < observations.length; i++) {
        var previousRoster = observations[i - 1].staff || [];
        var nextRoster = observations[i].staff || [];
        var at = observations[i].ts;
        var prevIds = {};
        var nextIds = {};
        previousRoster.forEach(function (e) { prevIds[String(e.id)] = e; });
        nextRoster.forEach(function (e) { nextIds[String(e.id)] = e; });
        previousRoster.concat(nextRoster).forEach(function (e) {
            var id = String(e.id);
            var oldEmployee = prevIds[id], newEmployee = nextIds[id];
            if (!!oldEmployee === !!newEmployee) return;
            var eventType = newEmployee ? 'joined' : 'unconfirmed';
            var duplicate = events.some(function (n) {
                return Math.abs(n.ts - at) <= 48 * 3600000 &&
                    (n.type === eventType || (eventType === 'unconfirmed' && (n.type === 'fired' || n.type === 'left'))) &&
                    n.text.toLowerCase().indexOf(String(e.name).toLowerCase()) >= 0;
            });
            if (duplicate || events.some(function (n) { return n.source === 'Roster comparison' && n.memberId === id && n.type === eventType; })) return;
            events.push({
                id: 'roster:' + id + ':' + at, memberId: id, ts: at, type: eventType,
                text: newEmployee ? e.name + ' appeared in the company roster.' :
                    e.name + ' disappeared from the company roster. Departure type not confirmed.',
                source: 'Roster comparison', reason: ''
            });
        });
    }
    events.sort(function (a, b) { return b.ts - a.ts; });
    var employeeChanges = [];
    if (baseline) {
        var oldById = {};
        (baseline.staff || []).forEach(function (e) { oldById[String(e.id)] = e; });
        current.staff.forEach(function (e) {
            var old = oldById[String(e.id)];
            if (!old) return;
            if (old.position !== e.position) employeeChanges.push({
                type: 'Position', name: e.name, text: old.position + ' → ' + e.position
            });
            if (old.wage != null && e.wage != null && old.wage !== e.wage) employeeChanges.push({
                type: 'Wage', name: e.name, text: money(old.wage) + ' → ' + money(e.wage)
            });
            var delta = num(e.effectiveness) - num(old.effectiveness);
            if (old.effectiveness != null && e.effectiveness != null && Math.abs(delta) >= 1) {
                employeeChanges.push({
                    type: 'Effectiveness', name: e.name,
                    text: fmt(old.effectiveness) + ' → ' + fmt(e.effectiveness) +
                        ' (' + (delta > 0 ? '+' : '') + fmt(delta) + ' points)'
                });
            }
        });
    }
    return { companyName: company.name, days: changePeriodDays(), current: current,
        baseline: baseline, partial: partial, events: events, metrics: metrics,
        employeeChanges: employeeChanges, newsCount: history.news.length };
}

function changeDate(ts) {
    return new Date(ts).toLocaleString('en-GB', {
        timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }) + ' TCT';
}

function metricText(value, kind) {
    if (kind === 'money') return money(value);
    if (kind === 'points') return fmt(value) + '%';
    return fmt(value);
}

function changeReportText(report) {
    if (!report) return 'No company change report available.';
    var lines = ['COMPANY CHANGES — ' + report.companyName,
        'Last ' + report.days + ' day(s) ending ' + changeDate(report.current.ts),
        'Comparison baseline: ' + (report.baseline ? changeDate(report.baseline.ts) : 'Not yet available'),
        report.partial ? 'Coverage: PARTIAL — tracking started late or a snapshot is missing.' : 'Coverage: Tracked period',
        '', 'PERFORMANCE CHANGES'];
    report.metrics.forEach(function (m) {
        lines.push(m.label + ': ' + metricText(m.previous, m.kind) + ' → ' +
            metricText(m.latest, m.kind) + ' (' + (m.delta > 0 ? '+' : '') +
            (m.kind === 'money' ? money(m.delta) : fmt(m.delta) +
            (m.kind === 'points' ? ' percentage points' : '')) + ')');
    });
    lines.push('', 'EMPLOYEE MOVEMENTS');
    report.events.forEach(function (e) {
        lines.push(changeDate(e.ts) + ' — ' + e.text + ' [' + e.source + ']' +
            (e.type === 'fired' ? ' | Reason: ' + (e.reason || 'Not stated in Torn news') +
                (e.reasonSource ? ' [' + e.reasonSource + ']' : '') : ''));
    });
    if (!report.events.length) lines.push('No tracked arrivals or departures in this period.');
    lines.push('', 'EMPLOYEE PERFORMANCE / ROLE CHANGES');
    report.employeeChanges.forEach(function (e) {
        lines.push(e.name + ' — ' + e.type + ': ' + e.text);
    });
    if (!report.employeeChanges.length) lines.push('No comparison changes recorded.');
    lines.push('', 'Daily/weekly income are point-in-time Torn values, NOT summed earnings over the selected period.',
        'Report assembled from Torn company news and automatically collected browser-local snapshots. Missing past observations cannot be recreated.');
    return lines.join('\n');
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
    var pure = x.statBestPosition;
    var req = best && best.required;
    var staffingNote = '';

    if (x.supportProtected) {
        staffingNote += '<div class="staffing-reason"><b>Support role protected</b><p>This employee stays in a support role because moving them could change company-wide effectiveness, training, marketing, environment, or reporting. Better individual stat fit alone is not sufficient.</p></div>';
    } else if (x.supportRisk) {
        staffingNote += '<div class="staffing-reason caution"><b>Manual review required</b><p>' + esc(x.supportRisk) + ' Compare observed company results before applying this move.</p></div>';
    }

    if (best && pure && pure.name !== best.name) {
        staffingNote += '<div class="staffing-reason"><b>Why not ' + esc(pure.name) + '?</b><p>' + esc(pure.name) + ' is the pure stat-fit winner for this employee (' + fmt(x.statBestFit) + '), but the staffing plan assigns ' + esc(best.name) + ' so the company keeps the required number of people in each role.</p></div>';
    }

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
        (best && !x.director && ui.page === 'positions' ? '<h4>Staffing-aware position</h4><div class="position-box"><div><b>' + esc(best.name) + '</b><small>Target: ' + fmt(x.staffingTarget) + ' employee' + (num(x.staffingTarget) === 1 ? '' : 's') + ' in this role. ' + esc(best.description || best.ability || 'Assigned using the company-wide staffing plan.') + '</small></div><strong>' + fmt(x.bestFit) + '</strong></div>' +
        '<div class="requirements"><span>Requires:</span>' + requirementBadge('MAN', req.manual) + requirementBadge('INT', req.intelligence) + requirementBadge('END', req.endurance) + '</div>' + staffingNote : '') +
        (ui.page === 'positions' ? '<p class="detail-note">Position recommendations maximize combined predicted work-stat fit within role counts. Support-role incumbents are preserved by default. Income and future bonuses cannot be reliably projected.</p>' :
        '<p class="detail-note">Wage recommendations use current employee work-stat effectiveness and total effectiveness. Open Positions to review roles, without changing wage calculations.</p>') +
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

function logoMark(cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 64 64" aria-hidden="true">' +
        '<rect x="7" y="9" width="50" height="46" rx="13" fill="#0d3528" stroke="#49c48a" stroke-width="3"></rect>' +
        '<path d="M20 43V31M31 43V23M42 43V34" stroke="#8cf0c2" stroke-width="5" stroke-linecap="round"></path>' +
        '<path d="M17 47h29" stroke="#e5fff2" stroke-width="4" stroke-linecap="round"></path>' +
        '<circle cx="48" cy="20" r="7" fill="#eafff3" stroke="#1f8b5c" stroke-width="2"></circle>' +
        '<path d="M48 16v8M44 20h8" stroke="#1f8b5c" stroke-width="2.2" stroke-linecap="round"></path>' +
    '</svg>';
}

function render() {
    var panel = S.querySelector('#panel');
    var result = staff.length ? calculate() : null;
    var visibleRows = result ? displayRows(result) : [];
    var stale = lastLoadedAt && Date.now() - lastLoadedAt > FRESH_AGE;
    var companyLine = company ? [company.name, company.typeName, company.rating ? company.rating + '★' : ''].filter(Boolean).join(' • ') : 'Company management assistant';
    var page = ui.page || 'overview';

    var html = '';
    html += '<header>' +
        '<div class="brand"><div class="logo">' + logoMark('brand-logo') + '</div><div><h2>Torn Company Helper <span>v' + VERSION + '</span></h2><p>' + esc(companyLine) + '</p></div></div>' +
        '<div class="header-actions"><span class="refresh-state ' + (stale ? 'stale' : '') + '">' + (lastLoadedAt ? 'Updated ' + nowText(lastLoadedAt) : 'Not loaded') + '</span><button class="icon-btn" data-a="close" aria-label="Close">×</button></div>' +
    '</header>';

    html += '<nav class="page-tabs" aria-label="Main company sections">' +
        pageTab('dashboard', 'Dashboard', 'At a glance') +
        pageTab('wages', 'Wages', 'Pay and employees', result ? result.rows.length : 0) +
        pageTab('positions', 'Positions', 'Roles and staffing') +
        pageTab('statistics', 'Statistics', 'Company performance') +
        pageTab('changes', 'Changes', 'History and news') +
    '</nav>';

    html += '<div class="workspace-tools"><span>More tools</span>' +
        '<button data-page="settings"' + (page === 'settings' ? ' aria-current="page" class="selected"' : '') + '>Settings</button>' +
        '<button data-page="guide"' + (page === 'guide' ? ' aria-current="page" class="selected"' : '') + '>How it works</button>' +
    '</div>';

    html += '<div class="actionbar section-actionbar ' + (page === 'wages' ? 'wages-actions' : '') + '">' +
        '<button class="primary" data-a="load"' + (busy ? ' disabled' : '') + '>' +
            (busy ? '<span class="spinner"></span> Refreshing' : '↻ Refresh data') + '</button>' +
        '<button data-a="key">API Key</button>' +
        (page === 'wages' ? '<button data-a="copy"' + (!result ? ' disabled' : '') +
            '>Copy wages</button><button data-a="csv"' + (!result ? ' disabled' : '') +
            '>Export CSV</button>' : '') +
    '</div>';

    html += '<div class="auto-recording-indicator" role="status" aria-live="polite">' +
        '<span class="auto-dot ' + (cfg.autoRefresh && apiKey() ? 'enabled' : 'paused') + '" aria-hidden="true"></span>' +
        '<span>' + esc(autoSyncStatusText()) + '</span>' +
        '<button type="button" data-page="settings" aria-label="Configure automatic company recording">Manage</button>' +
    '</div>';

    if (errorState) {
        var info = errorInfo(errorState);
        html += '<div class="error-card"><div class="error-icon">!</div><div><b>' + esc(info.title) + '</b><p>' + esc(info.message) + '</p><small><strong>Suggested fix:</strong> ' + esc(info.solution) + '</small><div class="error-actions"><button data-a="copy-error">Copy error details</button><a href="' + esc(SUPPORT_URL) + '" target="_blank" rel="noopener noreferrer">Contact developer</a></div></div><button data-a="dismiss-error">×</button></div>';
    }

    if (page === 'changes') {
        html += changesPage();
    } else if (page === 'settings') {
        html += settingsPage();
    } else if (page === 'guide') {
        html += calculationGuidePage();
    } else if (!result) {
        html += '<section class="empty">' +
            '<div class="empty-icon">' + logoMark('empty-logo') + '</div><h3>' +
            (busy ? 'Loading company information' : 'Welcome to your company dashboard') +
            '</h3><p>' + (busy ?
                'Fetching the latest company data. Your sections will appear here when the refresh is complete.' :
                'The helper records performance automatically when you visit your own company with an API key. Open Wages, Positions, Statistics, or Changes to review the information.') +
            '</p><div><button class="primary" data-a="load"' + (busy ? ' disabled' : '') +
            '>Refresh company data</button><button data-a="key">Set API Key</button></div></section>';
    } else if (page === 'wages') {
        html += wagesPage(result, visibleRows);
    } else if (page === 'positions') {
        html += positionsPage(result);
    } else if (page === 'statistics') {
        html += statisticsPage(result);
    } else {
        html += dashboardPage(result);
    }

    html += '<footer><span>API: ' + esc(keySource()) + '</span><span>Advisory only — wage changes are never submitted automatically.</span></footer>';
    if (detailId && result) html += '<div class="detail-overlay" data-a="detail-close"><div class="detail-shell">' + detailHtml(result.rows.find(function(x){return x.id===detailId;})) + '</div></div>';

    panel.innerHTML = html;
    bind(result);
}


function changesPage() {
    var report = changeReport();
    var html = '<section class="changes-page">' +
        '<div class="page-heading"><div><small>Company change tracker</small><h3>Company Changes</h3>' +
        '<p>See arrivals, departures, dismissals, employee effectiveness, and financial indicators. Based on official Torn news and snapshots saved on this device.</p></div></div>' +
        '<div class="changes-toolbar"><div class="changes-ranges" role="group" aria-label="Reporting period">' +
            [ [1, 'Daily'], [7, 'Weekly'], [30, 'Monthly'], [90, '90 days'] ].map(function (item) {
                return '<button class="' + (changePeriodDays() === item[0] ? 'selected' : '') +
                    '" data-change-range="' + item[0] + '" aria-pressed="' +
                    (changePeriodDays() === item[0] ? 'true' : 'false') + '">' + item[1] + '</button>';
            }).join('') +
        '</div><button class="changes-copy" data-a="copy-changes"' + (!report ? ' disabled' : '') +
        '>Copy report</button></div>';

    if (!report) {
        return html + '<div class="changes-empty"><h4>No company history yet</h4>' +
            '<p>Press Refresh with an API key that can access your company. Once auto-recording is enabled and your API key can access this company, the helper starts recording on your next company visit. Nothing needs to be refreshed manually.</p></div></section>';
    }
    var started = report.baseline ? changeDate(report.baseline.ts) : 'No earlier observation';
    html += '<div class="changes-coverage"><b>Last ' + report.days + ' day' + (report.days === 1 ? '' : 's') +
        '</b><span>Last refreshed: ' + esc(changeDate(report.current.ts)) +
        ' · Baseline: ' + esc(started) + '</span></div>';
    if (report.partial) {
        html += '<div class="notice changes-notice">Partial comparison: the selected period is not fully covered by saved snapshots. ' +
            'Missing intervals are not treated as zero change. Opening the helper and refreshing regularly improves coverage.</div>';
    }
    if (changesError) {
        html += '<div class="notice changes-notice">' + esc(changesError) + '</div>';
    }
    html += '<div class="changes-section-head"><h4>Performance comparisons</h4>' +
        '<small>Latest value versus the saved baseline, not total earnings over the selected period</small></div>';

    if (!report.metrics.length) {
        html += '<div class="changes-empty">A second snapshot is needed to show accurate differences. ' +
            'Your first refresh establishes a baseline.</div>';
    } else {
        html += '<div class="changes-metrics">' + report.metrics.map(function (m) {
            var sign = m.delta > 0 ? '+' : '';
            var deltaText = sign + (m.kind === 'money' ? money(m.delta) : fmt(m.delta) +
                (m.kind === 'points' ? ' pp' : ''));
            return '<article class="changes-metric"><small>' + esc(m.label) + '</small>' +
                '<strong>' + esc(metricText(m.latest, m.kind)) + '</strong>' +
                '<span class="' + (m.delta > 0 ? 'up' : m.delta < 0 ? 'down' : '') + '">' +
                esc(deltaText) + ' from ' + esc(metricText(m.previous, m.kind)) + '</span></article>';
        }).join('') + '</div>';
    }

    var counts = { joined: 0, fired: 0, left: 0, unconfirmed: 0 };
    report.events.forEach(function (e) { if (counts[e.type] != null) counts[e.type]++; });
    html += '<div class="changes-section-head"><h4>Employee movements</h4><small>Official news preferred; roster-only events are marked unconfirmed</small></div>' +
        '<div class="changes-counts">' +
            '<div><b>' + counts.joined + '</b><small>Joined</small></div>' +
            '<div><b>' + counts.left + '</b><small>Left</small></div>' +
            '<div><b>' + counts.fired + '</b><small>Dismissed</small></div>' +
            '<div><b>' + counts.unconfirmed + '</b><small>Unconfirmed exits</small></div>' +
        '</div>';
    if (!report.events.length) {
        html += '<div class="changes-empty">No recorded staff movement for the selected period. ' +
            'Older news may be unavailable if tracking only started recently.</div>';
    } else {
        html += '<div class="changes-timeline">' + report.events.slice(0, 60).map(function (e) {
            var label = { joined: 'Joined', fired: 'Dismissed', left: 'Left',
                unconfirmed: 'Unconfirmed', position: 'Role change' }[e.type] || 'Update';
            return '<article class="changes-event"><span class="changes-event-tag ' +
                esc(e.type) + '">' + esc(label) + '</span><div class="changes-event-content">' +
                '<b>' + esc(e.text) + '</b>' +
                (e.type === 'fired' ? '<p>Reason: ' +
                    esc(e.reason || 'Not stated in Torn company news') +
                    (e.reasonSource ? ' (' + esc(e.reasonSource) + ')' : '') + '</p>' +
                    (e.source === 'Torn news' ? '<div class="changes-reason-editor">' +
                    '<input aria-label="Edit dismissal reason" data-reason-id="' + esc(e.id) +
                    '" maxlength="300" value="' + esc(e.reasonSource === 'Director note' ? e.reason : '') +
                    '" placeholder="Optional private reason / note">' +
                    '<button data-save-reason="' + esc(e.id) + '">Save reason</button></div>' : '') : '') +
                '<small>' + esc(changeDate(e.ts)) + ' · ' + esc(e.source) + '</small></div></article>';
        }).join('') + '</div>';
        if (report.events.length > 60) html += '<div class="changes-overflow">Showing 60 of ' +
            fmt(report.events.length) + ' movements. Use Copy report for the full list.</div>';
    }

    html += '<div class="changes-section-head"><h4>Individual employee changes</h4>' +
        '<small>Compared with employees present at the baseline</small></div>';
    if (!report.employeeChanges.length) {
        html += '<div class="changes-empty">No recorded position, wage, or effectiveness differences.</div>';
    } else {
        html += '<div class="changes-employee-list">' +
            report.employeeChanges.slice(0, 80).map(function (e) {
                return '<div class="changes-employee-row"><span>' + esc(e.name) +
                    '<small>' + esc(e.type) + '</small></span><b>' + esc(e.text) + '</b></div>';
            }).join('') + '</div>';
        if (report.employeeChanges.length > 80) html += '<div class="changes-overflow">Showing the first 80 employee changes. Copy report includes all.</div>';
    }
    html += '<p class="changes-footnote">Daily and weekly Torn income figures are rolling figures from each refresh; their difference is not the total profit over this period. ' +
        'History is saved automatically in this browser, per company, for up to 180 days. Recent changes are recorded individually, and older samples are condensed. ' +
        'Dismissal reasons come from Torn news or private notes you enter. Copied reports include those notes, so review before sharing. Other devices do not share this history.</p></section>';
    return html;
}

function pageTab(key, label, note, count) {
    var selected = (ui.page || 'dashboard') === key;
    return '<button class="page-tab ' + (selected ? 'active' : '') + '" type="button" data-page="' + key + '"' +
        (selected ? ' aria-current="page"' : '') + '>' +
        '<span class="page-tab-main">' + esc(label) + (count != null ? '<b>' + fmt(count) + '</b>' : '') + '</span>' +
        '<small>' + esc(note) + '</small>' +
    '</button>';
}

function staffingPlanEditor() {
    if (!staff.length || !positions.length || !company) {
        return '<div class="staffing-empty">Load company data first to configure position counts.</div>';
    }

    var info = staffingPlanInfo();
    var positionRows = positions.slice().sort(function (a, b) {
        var ac = num(info.target[positionKey(a)]) + num(info.current[positionKey(a)]);
        var bc = num(info.target[positionKey(b)]) + num(info.current[positionKey(b)]);
        return bc - ac || a.name.localeCompare(b.name);
    });
    var stateClass = info.safe ? 'valid' : 'invalid';
    var reducedSupport = positions.filter(function (p) {
        return supportRoleKind(p) && num(info.target[positionKey(p)]) < num(info.current[positionKey(p)]);
    }).map(function (p) { return p.name; });
    var statusText = !info.valid ?
        'Target slots total ' + fmt(info.targetTotal) + ', but you have ' + fmt(info.employeeTotal) + ' non-director employees. Current position counts are used until the totals match.' :
        info.coverageWarnings.length ?
            'Safety hold: this plan removes the last employee from ' + info.coverageWarnings.join(', ') + '. Current position counts remain active unless role-coverage protection is disabled.' :
            'Target slots match your ' + fmt(info.employeeTotal) + ' non-director employees and preserve current operating-role coverage.';

    var html = '<div class="staffing-summary ' + stateClass + '"><div><b>' + (info.customApplied ? 'Custom staffing targets active' : info.custom ? 'Custom targets paused by safeguards' : 'Current position counts preserved') + '</b><small>' + esc(statusText) + '</small></div><button data-a="reset-staffing">Use current counts</button></div>';
    if (reducedSupport.length) html += '<div class="notice">Support-role reductions require review: ' + esc(reducedSupport.join(', ')) + '. Incumbents cannot all be protected when their slots are removed.</div>';
    html += '<div class="staffing-table"><div class="staffing-head"><span>Position</span><span>Current</span><span>Target</span></div>';

    positionRows.forEach(function (p) {
        var key = positionKey(p);
        var special = p.ability && p.ability !== 'None' ? p.ability : '';
        var family = supportRoleKind(p);
        html += '<label class="staffing-row"><span class="staffing-role"><b>' + esc(p.name) + '</b>' + (family ? '<small>Support role: ' + esc(family) + '</small>' : '') + (special ? '<small>Special: ' + esc(special) + '</small>' : '') + '</span>' +
            '<span class="staffing-current">' + fmt(info.current[key] || 0) + '</span>' +
            '<input type="number" min="0" max="' + fmt(info.employeeTotal) + '" inputmode="numeric" data-staffing-target="' + esc(key) + '" value="' + fmt(info.target[key] || 0) + '">' +
        '</label>';
    });

    html += '</div>';
    return html;
}

function settingsPage() {
    return '<section class="settings settings-page">' +
        '<div class="page-heading"><div><small>Calculation setup</small><h3>Wage settings & preferences</h3><p>Control how suggested daily pay is calculated. For staffing targets and job assignments, open Positions.</p></div><button class="text-btn" data-a="reset-settings">Reset defaults</button></div>' +
        '<div class="settings-group"><div class="settings-group-title"><b>Payment model</b><small>Choose how the suggested payroll is calculated.</small></div><div class="settings-grid">' +
            settingField('mode', 'Payment model', 'Current redistributes the included payroll. Fixed uses your chosen budget. Benchmark pays score × benchmark.', 'mode') +
            settingField('budget', 'Fixed daily payroll', 'Used only when Payment model is Fixed budget.') +
            settingField('benchmark', 'Benchmark wage', 'A score of 1.000 receives approximately this amount.') +
        '</div></div>' +
        '<div class="settings-group"><div class="settings-group-title"><b>Scoring</b><small>Control how much position fit and total effectiveness matter.</small></div><div class="settings-grid">' +
            settingField('target', 'Target effectiveness', 'Effectiveness treated as the baseline 1.000 contribution.') +
            settingField('stats', 'Position-fit weight', 'Weight given to employee work-stat efficiency in the current role.') +
            settingField('eff', 'Effectiveness weight', 'Weight given to total effectiveness, including modifiers.') +
        '</div></div>' +
        '<div class="settings-group"><div class="settings-group-title"><b>Limits & rounding</b><small>Set wage boundaries and clean recommendation increments.</small></div><div class="settings-grid">' +
            settingField('min', 'Minimum wage', 'Floor applied to every included employee.') +
            settingField('max', 'Maximum wage', 'Cap applied to every included employee.') +
            settingField('round', 'Round to', 'Use 100, 1,000, 10,000, etc. The allocator tries to preserve the chosen total.') +
        '</div></div>' +
        '<div class="settings-group"><div class="settings-group-title"><b>Helper behavior</b><small>Optional conveniences and recommendations.</small></div><div class="toggles">' +
            toggle('director', 'Include director', 'Include the director in wage distribution.') +
            toggle('fill', 'Safe wage autofill', 'Fill the matching Torn wage field but never press Update or Save.') +
            toggle('autoRefresh', 'Auto-refresh and record company visits (recommended)', 'Automatically save performance when visiting your company, making management changes, or returning to the tab. Checks every 5 minutes while visible; API key required.') +
        '</div></div>' +
        '<div class="settings-group settings-route"><div><b>Looking for staffing and position settings?</b>' +
        '<p>Role protection, additional role recommendations, and staffing targets are together in the Positions section.</p></div>' +
        '<button data-page="positions">Open Positions →</button></div>' +
    '</section>';
}

function calculationGuidePage() {
    var statWeight = num(cfg.stats);
    var effWeight = num(cfg.eff);
    var totalWeight = Math.max(1, statWeight + effWeight);
    var sampleStatFactor = 1.10;
    var sampleEffFactor = 1.05;
    var sampleScore = (sampleStatFactor * statWeight + sampleEffFactor * effWeight) / totalWeight;
    var modeName = cfg.mode === 'fixed' ? 'Fixed budget' : cfg.mode === 'benchmark' ? 'Benchmark × score' : 'Keep included payroll';

    return '<section class="guide-page">' +
        '<div class="page-heading"><div><small>Help center</small><h3>How it works</h3><p>Find what each section does, then explore the calculations and limitations behind its recommendations.</p></div></div>' +
        '<div class="guide-shortcuts" aria-label="Jump to a section">' +
        '<button data-page="dashboard">Dashboard</button><button data-page="wages">Wages</button>' +
        '<button data-page="positions">Positions</button><button data-page="statistics">Statistics</button>' +
        '<button data-page="changes">Changes</button></div>' +
        '<div class="guide-settings">' +
            '<div><small>Current mode</small><b>' + esc(modeName) + '</b></div>' +
            '<div><small>Target effectiveness</small><b>' + fmt(cfg.target) + '</b></div>' +
            '<div><small>Position-fit weight</small><b>' + fmt(cfg.stats) + '</b></div>' +
            '<div><small>Effectiveness weight</small><b>' + fmt(cfg.eff) + '</b></div>' +
            '<div><small>Wage limits</small><b>' + money(cfg.min) + ' – ' + money(cfg.max) + '</b></div>' +
            '<div><small>Round to</small><b>' + money(cfg.round) + '</b></div>' +
        '</div>' +
        '<div class="guide-grid">' +
            guideCard('1', 'Who is included?', 'Only employees marked Included take part in wage distribution. If Include director is off, the director is also excluded. Excluded employees keep their current wage and do not affect the target payroll.', '', 'If a company has 10 employees and 2 are excluded, the wage model distributes payroll across the remaining 8 employees.') +
            guideCard('2', 'Position-fit calculation', 'If Torn provides work-stat efficiency for an employee, that API value is used for wage scoring. When it is unavailable, the helper calculates fit from the MAN, INT, and END requirements of the current position. Only stats with a requirement above zero are counted, and their contributions are added together.', 'Contribution = floor(min(45, 45 × Stat ÷ Requirement) + max(0, 5 × log2(Stat ÷ Requirement)))', 'MAN 1,500 with requirement 1,000 gives 47. INT 500 with requirement 500 gives 45. If those are the only required stats, calculated position fit = 92.') +
            guideCard('3', 'Wage score', 'Work-stat efficiency and total effectiveness are normalized, limited to a factor between 0.05 and 3, weighted using Settings, then combined into one wage score.', 'StatFactor = clamp(WorkStat ÷ 100, 0.05, 3); EffFactor = clamp(TotalEff ÷ TargetEff, 0.05, 3); Score = (StatFactor × StatWeight + EffFactor × EffWeight) ÷ TotalWeight', 'Using work-stat efficiency 110, effectiveness 105, target 100, and your current weights ' + fmt(statWeight) + '/' + fmt(effWeight) + ' gives score ' + sampleScore.toFixed(4) + '.') +
            guideCard('4', 'Current payroll mode', 'Keep included payroll uses the current total wage of included employees as the target. Scores decide how that same total is redistributed, subject to minimum and maximum wage limits.', 'Target payroll = sum of current wages for included employees', 'Two employees with scores 1.20 and 0.80 sharing a $2,000,000 target receive about $1,200,000 and $800,000 before limits and rounding.') +
            guideCard('5', 'Fixed budget mode', 'Fixed budget uses the same score-based allocator as Current payroll mode, but the target comes from Fixed daily payroll in Settings.', 'Target payroll = Fixed daily payroll', 'With a $3,000,000 fixed target, the allocator distributes $3,000,000 across included employees according to their scores, unless wage limits make that exact total impossible.') +
            guideCard('6', 'Benchmark mode', 'Benchmark mode does not preserve a company-wide payroll total. Each included employee is calculated independently, then minimum, maximum, and rounding rules are applied.', 'Raw wage = Benchmark wage × Score', 'With benchmark $1,000,000 and score 1.0675, raw wage = $1,067,500 before limits and rounding.') +
            guideCard('7', 'Minimum and maximum wages', 'For Current and Fixed modes, the target itself is constrained to a feasible range. The allocator starts each included employee at the minimum wage, distributes the remainder by score, caps employees that reach the maximum, and redistributes what remains.', 'Feasible target = clamp(Target, Minimum × Employees, Maximum × Employees)', 'For 5 included employees with a $100,000 minimum, the target cannot be lower than $500,000. A maximum wage can similarly cap the highest possible total.') +
            guideCard('8', 'Rounding and payroll balancing', 'Each raw wage is rounded to the Round to increment. In Current and Fixed modes, the helper then moves eligible wages up or down by one increment at a time to keep the final payroll as close as possible to the target.', 'Rounded wage = round(Raw wage ÷ Step) × Step', 'With Round to $10,000, $1,067,500 becomes $1,070,000. If this pushes the total payroll too high, another eligible recommendation can be reduced by $10,000.') +
            guideCard('9', 'Raise, cut, and change percentage', 'The employee list compares the suggested wage with the current wage. A positive difference is a raise; a negative difference is a cut.', 'Change = Suggested − Current; Change % = Change ÷ Current × 100', 'Current $1,000,000 and suggested $1,250,000 gives +$250,000, or +25%.') +
            guideCard('10', 'Staffing-aware position assignment', 'The helper fills target slots using combined predicted work-stat fit and a 2-point staying bonus, but it no longer treats stat fit as the whole-company objective. Existing Managers, Marketers, Trainers, Cleaners, and Secretaries are reserved first. With role-coverage protection enabled, automatic advice also preserves at least one slot in every currently staffed operating role such as Administrator, Technician, or Cashier.', 'Preserve support incumbents + current role coverage; then maximize remaining PositionFit + 2 when staying', 'If the company has exactly one Administrator, an automatic Marketer suggestion may use a duplicated Cashier slot but cannot remove the only Administrator just because the Administrator would score better as Cashier.') +
            guideCard('11', 'Custom staffing targets', 'The director can choose how many employees should fill each position. Targets must add up to the non-director employee count. By default, a custom plan that reduces any currently staffed role to zero is paused and current counts remain active. You can disable role-coverage protection for an intentional restructure, but doing so removes this safety barrier.', 'Valid plan = correct employee total + no protected current role reduced to zero', 'For 9 employees with 1 Administrator, changing the Administrator target to 0 will be held by the safeguard until role-coverage protection is deliberately disabled.') +
            guideCard('12', 'Summary values', 'The Dashboard and Wages pages average included employees only. Budget variance is the final included payroll minus the target payroll. In Benchmark mode there is no fixed company target, so budget variance is shown as not applicable.', 'Budget variance = Suggested included payroll − Target payroll', 'If the target is $10,000,000 and rounded recommendations total $10,010,000, budget variance is +$10,000.') +
            guideCard('13', 'Discovering unstaffed and recently removed roles', 'The Positions section reviews every company-type role with zero current slots. Special roles are described using Torn\'s catalog ability. Ordinary roles normally need a modeled team-fit benefit, but local history can create a recovery signal when a recently removed role coincides with a material daily-income decline. That signal is explicitly labeled as correlation, not proof.', 'Unstaffed role opportunity = safe fit/special-role case OR strong recent recovery signal', 'If Administrator disappears and the recorded daily income later falls sharply while headcount is unchanged, Administrator can be promoted as a role to test restoring even if its pure stat-fit score is not the highest.') +
            guideCard('14', 'Comparing a safe alternate staffing mix', 'For a possible new role, the helper may reallocate only a duplicated non-support slot above its protected coverage floor. It preserves support-role incumbents and refuses to zero-out an existing operating role automatically. When history shows which role count increased as another role disappeared, the helper prefers reversing that specific change. It still reports the separate modeled stat-fit difference and never invents a sales forecast.', 'Safe donor count must remain at least 1 for every currently staffed operating role', 'If Administrator fell from 1 to 0 while Cashier rose from 1 to 2, a restoration scenario prefers moving one Cashier slot back to Administrator instead of sacrificing a different unique role.') +
            guideCard('15', 'Hiring, applying, and limitations', 'If no duplicated role can be reduced safely, the helper will not manufacture a reallocation just to add a new role. It can instead show a hiring path when capacity is available, or leave the idea for manual director review. The helper does not know Torn\'s complete company-income formula, so preserving observed role coverage takes priority over squeezing out a few extra stat-fit points.', 'No safe donor = no automatic role replacement', 'With nine employees all occupying unique roles, adding a Marketer does not justify deleting the only Administrator. The helper will require a vacancy, a duplicated donor role, or a deliberate manual restructure.') +
            guideCard('16', 'Finding your way around', 'The Dashboard shows concise summaries and opens dedicated sections. Wages contains pay suggestions and exports. Positions contains role recommendations, support-role safeguards, exploratory role options, and staffing targets. Company Statistics displays current income, customers, company condition, resources, and available historical comparisons. Changes records events and performance differences. Settings controls wage calculations and general behavior.', 'Dashboard → choose a section → review details → return using the top navigation', 'To decide whether to introduce a Trainer, open Positions. To see income figures, open Statistics. To compare activity across days, open Changes. To export suggested daily pay, open Wages.') +
            guideCard('17', 'Automatic company refresh and data recording', 'With Auto-refresh and record enabled, the helper checks your company after visits and management activity and periodically while visible. Recorded snapshots now also help identify risky role removals: if a previously staffed role disappears and daily income later drops materially, the Positions section can surface a recovery signal. Because other factors such as advertising, employee changes, prices, or Torn\'s daily update timing can also affect income, the helper never treats this history as proof of causation.', 'History supplies evidence and warnings, not a guaranteed profit model', 'If Administrator disappears and income later drops roughly 50%, the helper can prioritize testing Administrator again and show the before/after income evidence while still warning that other changes may have contributed.') +
        '</div>' +
        '<div class="guide-note"><b>Important:</b> Torn Company Helper is advisory. The recommender now prioritizes preserving special-role effects and existing operating-role coverage over pure stat-fit gains. Historical recovery signals are observed correlations, not guaranteed profit improvements. Nothing hires staff or submits role or wage changes to Torn automatically.</div>' +
    '</section>';
}

function guideCard(step, title, textValue, formula, sample) {
    return '<article class="guide-card"><div class="guide-card-head"><span>' + esc(step) + '</span><h4>' + esc(title) + '</h4></div><p>' + esc(textValue) + '</p>' +
        (formula ? '<div class="formula">' + esc(formula) + '</div>' : '') +
        '<div class="guide-sample"><b>Example</b><p>' + esc(sample) + '</p></div></article>';
}


function supportImpactHtml(result) {
    var snapshot = result.support || supportRoleSnapshot();
    var labels = { manager:'Managers', marketer:'Marketers', trainer:'Trainers',
        cleaner:'Cleaners', secretary:'Secretaries' };
    var kinds = Object.keys(labels).filter(function (kind) {
        return num(snapshot.counts[kind]) > 0;
    }).map(function (kind) {
        return fmt(snapshot.counts[kind]) + ' ' + labels[kind];
    });
    var bonusText = snapshot.managementReported ?
        'Observed Management bonuses: +' + fmt(snapshot.managementTotal) +
        ' effectiveness points across ' + fmt(snapshot.managementRecipients) +
        ' employee(s), as currently reported by Torn.' :
        'Individual Management bonus components were not returned by Torn.';
    var risks = result.supportRisks || [];
    var html = '<section class="support-impact">' +
        '<div class="support-impact-head"><div><small>Position safeguards</small>' +
        '<h4>Support-role impact</h4></div><b class="' +
        (cfg.protectSupportRoles ? 'positive' : 'negative') + '">' +
        (cfg.protectSupportRoles ? 'Protected' : 'Unprotected') + '</b></div>' +
        '<p>' + esc(kinds.length ? kinds.join(' · ') : 'No recognized current support-role occupants.') + '</p>' +
        '<p>' + esc(bonusText) + ' These are observed values, NOT a forecast of the effects of swapping roles.</p>' +
        '<p>' + (cfg.protectRoleCoverage !== false ?
            'Operating-role coverage is also protected: automatic advice will not eliminate the last currently staffed Administrator, Technician, Cashier, or other operating role.' :
            'Operating-role coverage protection is disabled; recommendations may eliminate a currently staffed role.') + '</p>' +
        '<p>' + (!cfg.positionAdvice ? 'Position advice is disabled; no position moves are recommended.' :
            (cfg.protectSupportRoles ?
            fmt(result.protectedCount) + ' support-role incumbent(s) reserved in their current slots.' :
            'Protection is disabled. Stat-fit advice may rearrange support roles.')) + '</p>';
    if (risks.length) {
        html += '<div class="support-risk"><b>' + fmt(risks.length) +
            ' support-role change(s) require director review.</b>' +
            '<p>These moves have unknown company-wide effectiveness and income effects. Do not assume a better stat fit means higher profit.</p>' +
            '<ul>' + risks.slice(0, 5).map(function (x) {
                return '<li>' + esc(x.name + ': ' + x.from + ' → ' + x.to) + '</li>';
            }).join('') + '</ul></div>';
    }
    return html + '</section>';
}

function additionalRolesHtml() {
    if (!cfg.positionAdvice || cfg.exploreNewRoles === false || !positions.length) return '';
    var candidates = suggestAdditionalRoles();
    var content = candidates.length ? candidates.map(function (x) {
        var recovery = x.historySignal && x.historySignal.strong ?
            '<p class="role-recovery"><b>Observed recovery signal:</b> tracked daily income is ' +
                esc(pct(x.historySignal.declinePct, 0)) +
                ' lower than the last recent snapshot that still had this role. ' +
                'This is correlation, not proof; use it as a reason to test restoring the role.</p>' : '';
        var details = x.plan ?
            '<p><b>' + (x.plan.historicalReverse ? 'Likely restoration path' : 'Reallocation scenario') +
                ':</b> move one duplicated/safe planned slot from ' + esc(x.plan.replaces) +
                ' to ' + esc(x.position) + '.</p>' +
            '<p class="' + (x.plan.fitDelta >= 0 ? 'role-positive' : 'role-caution') + '">' +
                'Combined modeled stat-fit change: ' + (x.plan.fitDelta > 0 ? '+' : '') +
                fmt(x.plan.fitDelta) + ' points. ' +
                (x.kind ? 'The special-role benefit is NOT included in this score.' :
                    x.historySignal ? 'Historical income evidence is separate from this stat-fit score.' :
                    'Higher fit does not guarantee higher income.') + '</p>' :
            '<p>No safe duplicated non-support slot is available for automatic reassignment. Keep current role coverage; use a vacancy or make a manual director-reviewed change instead.</p>';
        var vacancy = x.openCapacity ?
            '<p>Hiring path: ' + fmt(x.openCapacity) +
                ' unfilled company slot(s) reported. A new hire needs their own stats and wage assessment.</p>' : '';
        return '<article class="role-opportunity">' +
            '<div class="role-opportunity-head"><div><small>' +
                esc(x.kind ? 'Unstaffed ' + x.kind + ' ability' : 'Unstaffed production role') +
                '</small><h5>' + esc(x.position) + '</h5></div>' +
                '<span class="role-type">' + esc(x.kind ? 'Support opportunity' : 'Stat-fit opportunity') + '</span></div>' +
            '<p>' + esc(x.reason) + '</p>' + recovery + details + vacancy +
            (x.plan ?
                '<button data-use-new-role="' + esc(x.key) +
                '">Use as staffing target (helper only)</button>' :
                '<small class="role-caution">Hiring suggestion only; no employee reassignment can be modeled.</small>') +
            '</article>';
    }).join('') : '<p class="role-opportunity-empty">No additional roles passed the current eligibility checks. ' +
        'This does not establish that your existing staffing mix maximizes revenue.</p>';
    return '<section class="role-opportunities"><div class="role-opportunities-intro">' +
        '<div><small>Beyond your current staff mix</small><h4>Additional roles worth considering</h4>' +
        '<p>The helper reviews the full company position catalog, including roles with no current employees. ' +
        'Automatic reallocations preserve special-role incumbents and at least one slot in every currently staffed operating role. Recent local history can also flag a removed role when its absence coincides with a sharp income decline.</p></div>' +
        '<button data-page="guide">How recommendations work</button></div>' +
        '<div class="role-opportunity-grid">' + content + '</div>' +
        '<p class="role-opportunity-disclaimer">These are exploratory options, NOT proven income improvements. ' +
        'Automatic suggestions preserve existing role coverage by default. Historical recovery signals show observed before/after income correlation and may still have other causes. ' +
        'The stat-fit difference excludes changes to sales, management bonuses, advertising, environment, and training. ' +
        'Choosing a target updates this helper only. No positions or wages are changed in Torn.</p></section>';
}


function dashboardLink(key, eyebrow, title, number, subtitle, details) {
    return '<button type="button" class="dashboard-link" data-page="' + esc(key) + '">' +
        '<span class="dashboard-card-top"><span>' + esc(eyebrow) + '</span><span aria-hidden="true">↗</span></span>' +
        '<strong>' + esc(title) + '</strong>' +
        '<span class="dashboard-card-number">' + esc(number) + '</span>' +
        '<span class="dashboard-card-description">' + esc(subtitle) + '</span>' +
        '<span class="dashboard-card-footer">' + esc(details) + '<b>Open ' + esc(title) + ' →</b></span>' +
    '</button>';
}

function dashboardPage(result) {
    var payChanges = result.rows.filter(function (x) { return !x.omit && x.change !== 0; }).length;
    var changes = result.rows.filter(function (x) { return x.recommendPosition; }).length;
    var history = changeReport();
    var movements = history ? history.events.filter(function (e) {
        return ['joined', 'fired', 'left', 'unconfirmed'].indexOf(e.type) >= 0;
    }).length : 0;
    var plans = cfg.positionAdvice && cfg.exploreNewRoles && positions.length ?
        suggestAdditionalRoles().length : 0;
    var days = changePeriodDays();
    var title = company && company.name ? company.name : 'Your company';
    var html = '<section class="dashboard-page">' +
        '<div class="page-heading dashboard-hero"><div><small>Company control center</small>' +
        '<h3>' + esc(title) + ' at a glance</h3>' +
        '<p>Everything important, in one place. Choose a section below to review details and take action.</p></div>' +
        '<button data-page="guide" class="small">How to use this helper</button></div>' +
        '<div class="dashboard-quick-stats">' +
            summaryCard('Employees', fmt(staff.length), 'Currently recorded in Torn') +
            summaryCard('Daily income', company ? money(company.dailyIncome) : '—', 'Current rolling Torn figure') +
            summaryCard('Avg. effectiveness', fmt(result.avgEffectiveness), 'Included employees') +
            summaryCard('Company rating', company && company.rating ? fmt(company.rating) + ' ★' : '—', 'Latest reported stars') +
        '</div>' +
        '<div class="dashboard-section-title"><h4>Explore your company</h4><p>Each section has one purpose. Nothing is changed in Torn automatically.</p></div>' +
        '<div class="dashboard-links">' +
            dashboardLink('wages', '01 · Daily payroll', 'Wages',
                money(result.currentIncluded),
                money(result.suggestedIncluded) + ' suggested daily payroll',
                fmt(payChanges) + ' proposed wage change(s)') +
            dashboardLink('positions', '02 · Team structure', 'Positions',
                fmt(changes) + ' to review',
                fmt(result.protectedCount) + ' existing support-role assignment(s) protected',
                fmt(plans) + ' additional role option(s)') +
            dashboardLink('statistics', '03 · Business health', 'Statistics',
                company ? money(company.weeklyIncome) : '—',
                'Current rolling weekly income (not profit)',
                'View revenue, customers and company indicators') +
            dashboardLink('changes', '04 · Recent activity', 'Changes',
                history ? fmt(movements) + ' events' : 'Tracking',
                'Employee movements over the selected ' + days + '-day period',
                history && history.partial ? 'Limited historical coverage' : 'View history and export reports') +
        '</div>' +
        '<div class="dashboard-next"><div><b>Not sure where to start?</b>' +
        '<p>Review Wages for pay adjustments, Positions for staffing ideas, and Statistics for company performance. Use Changes to see what happened over time.</p></div>' +
        '<button data-page="wages">Review wages →</button></div>' +
    '</section>';
    return html;
}

function insightCard(title, list, valueFn, emptyText, filterKey) {
    var shown = list.slice(0, 4);
    var body = shown.length ? shown.map(function (x) {
        return '<button class="insight-row" data-detail="' + esc(x.id) + '"><span><b>' + esc(x.name) + '</b><small>' + esc(x.position) + '</small></span><strong>' + esc(valueFn(x)) + '</strong></button>';
    }).join('') : '<div class="insight-empty">✓ ' + esc(emptyText) + '</div>';
    return '<div class="insight-card"><div class="insight-head"><div><b>' + esc(title) + '</b><small>' + fmt(list.length) + ' employee' + (list.length === 1 ? '' : 's') + '</small></div>' + (list.length ? '<button data-filter-jump="' + filterKey + '">See all</button>' : '') + '</div>' + body + '</div>';
}


function wagesPage(result, visibleRows) {
    var changed = result.rows.filter(function (x) { return !x.omit && x.change !== 0; }).length;
    return '<section class="wages-summary">' +
        '<div class="page-heading"><div><small>Employee payroll</small><h3>Wages</h3>' +
        '<p>Review daily wages and suggested pay. Position planning lives in its own section.</p></div>' +
        '<button data-page="settings" class="small">Wage settings</button></div>' +
        '<div class="summary">' +
            summaryCard('Current daily payroll', money(result.currentIncluded), 'Included employees') +
            summaryCard('Suggested daily payroll', money(result.suggestedIncluded), 'Based on your wage settings') +
            summaryCard('Proposed changes', fmt(changed), 'Raises or cuts; review before applying') +
        '</div></section>' + employeesPage(result, visibleRows);
}

function positionStat(label, value, note) {
    return '<div class="positions-metric"><small>' + esc(label) + '</small>' +
        '<strong>' + esc(value) + '</strong><span>' + esc(note) + '</span></div>';
}

function positionsPage(result) {
    var reviews = result.rows.filter(function (x) { return x.recommendPosition && !x.director; });
    var plan = result.positionPlan;
    var nonDirectors = staff.filter(function (x) { return !x.director; });
    var html = '<section class="positions-page">' +
        '<div class="page-heading"><div><small>People and job assignments</small><h3>Positions</h3>' +
        '<p>See who works where, explore other jobs, and adjust your staffing plan without changing Torn automatically.</p></div>' +
        '<button class="small" data-page="guide">How role advice works</button></div>' +
        '<div class="positions-metrics">' +
            positionStat('Employees in positions', fmt(nonDirectors.length), 'Excludes the director') +
            positionStat('Suggested changes', cfg.positionAdvice ? fmt(reviews.length) : 'Off', 'Review before changing jobs') +
            positionStat('Protected support roles', fmt(result.protectedCount), 'Existing support employees kept in place') +
            positionStat('Protected role coverage', fmt(result.coverageProtectedCount), 'Currently staffed roles kept from dropping to zero') +
        '</div>';
    if (!positions.length) {
        return html + '<div class="notice"><b>Position information unavailable.</b> Refresh company data to load available jobs.</div></section>';
    }
    if (!cfg.positionAdvice) html += '<div class="notice">Position advice is disabled. Enable it below to see staffing recommendations.</div>';
    html += '<div class="positions-section-head"><div><h4>Employee assignments</h4>' +
        '<p>Current role compared with the recommended role. Fit differences measure working stats only, not income.</p></div></div>' +
        '<div class="positions-employee-list">';
    var listed = result.rows.filter(function (x) { return !x.director; }).sort(function (a,b) {
        return Number(b.recommendPosition) - Number(a.recommendPosition) || a.name.localeCompare(b.name);
    });
    listed.forEach(function (x) {
        var proposed = cfg.positionAdvice ? x.bestPosition : null;
        var diff = proposed ? num(x.bestFit) - num(x.predictedCurrentFit) : 0;
        var status = x.supportRisk ? 'Check support impact' :
            x.supportProtected ? 'Support role protected' :
            x.recommendPosition ? 'Review proposed move' : 'Keep current role';
        html += '<div class="positions-person">' +
            '<div class="positions-person-main"><b>' + esc(x.name) + '</b><small>[' + esc(x.id) + ']</small></div>' +
            '<div class="positions-person-roles"><div><small>Current</small><span>' + esc(x.position) + '</span></div>' +
            '<div><small>Suggested</small><span>' +
            (proposed ? esc(proposed.name) : 'No advice') + '</span></div></div>' +
            '<div class="positions-person-status ' + (x.supportRisk ? 'caution' : x.recommendPosition ? 'review' : 'keep') + '">' +
                '<span>' + esc(status) + '</span>' +
                '<small>' + (proposed ? 'Stat-fit difference: ' + (diff > 0 ? '+' : '') + fmt(diff) : '—') +
                '</small></div>' +
            '<button class="small" data-detail="' + esc(x.id) + '">Details</button>' +
        '</div>';
    });
    html += '</div>';
    html += supportImpactHtml(result);
    html += additionalRolesHtml();
    html += '<div class="positions-section-head"><div><h4>Staffing targets</h4>' +
        '<p>Set how many employees should fill each job. Targets must add up to your current number of employees. Suggestions are helper-only.</p></div></div>' +
        '<div class="positions-planner">' + staffingPlanEditor() + '</div>' +
        '<div class="settings-group positions-preferences"><div class="settings-group-title"><b>Position preferences</b>' +
            '<small>Customize role recommendations. Changes recalculate immediately.</small></div>' +
        '<div class="toggles">' +
            toggle('positionAdvice', 'Show position recommendations', 'Compare proposed roles with current assignments.') +
            toggle('protectSupportRoles', 'Protect support-role incumbents (recommended)', 'Keep current Managers, Trainers, Marketers, Cleaners, and Secretaries when their slots remain.') +
            toggle('protectRoleCoverage', 'Protect existing role coverage (strongly recommended)', 'Automatic advice will not remove the last employee from a currently staffed role such as Administrator, Technician, or Cashier. Disable only if you intentionally want to eliminate a role.') +
            toggle('exploreNewRoles', 'Explore additional positions', 'Consider unstaffed positions, safe alternatives, historical recovery signals, and hiring capacity.') +
        '</div></div></section>';
    return html;
}

function statisticsTile(label, key, suffix, note, kind) {
    var v = company && company[key];
    var shown = v == null ? 'Not reported' : kind === 'money' ? money(v) :
        fmt(v) + (suffix || '');
    return '<div class="stats-tile"><small>' + esc(label) + '</small><strong>' +
        esc(shown) + '</strong><span>' + esc(note) + '</span></div>';
}

function statisticsPage(result) {
    var history = changeReport();
    var html = '<section class="statistics-page">' +
        '<div class="page-heading"><div><small>Business performance</small><h3>Company Statistics</h3>' +
        '<p>Understand your current figures without mixing them with wage or position recommendations.</p></div>' +
        '<button class="small" data-page="changes">View historical changes</button></div>' +
        '<div class="stats-explain"><b>How to read these numbers</b>' +
        '<p>Income figures are the daily or weekly rolling amounts reported by Torn. They are <b>not net profit</b>. ' +
        'Company funds are a balance, not earnings.</p></div>' +
        '<div class="positions-section-head"><div><h4>Income and customers</h4>' +
        '<p>Latest values from your company profile.</p></div></div>' +
        '<div class="stats-grid">' +
            statisticsTile('Daily income', 'dailyIncome', '', 'Torn rolling daily figure', 'money') +
            statisticsTile('Weekly income', 'weeklyIncome', '', 'Torn rolling weekly figure', 'money') +
            statisticsTile('Daily customers', 'dailyCustomers', '', 'Customers reported by Torn') +
            statisticsTile('Weekly customers', 'weeklyCustomers', '', 'Customers reported by Torn') +
        '</div>' +
        '<div class="positions-section-head"><div><h4>Business condition</h4>' +
        '<p>These indicators are reported by Torn; they are not guaranteed outcomes of role changes.</p></div></div>' +
        '<div class="stats-grid">' +
            statisticsTile('Efficiency', 'efficiency', '', 'Company-wide indicator') +
            statisticsTile('Popularity', 'popularity', '', 'Company-wide indicator') +
            statisticsTile('Environment', 'environment', '', 'Company-wide indicator') +
            statisticsTile('Company rating', 'rating', ' ★', 'Current star rating') +
        '</div>' +
        '<div class="positions-section-head"><div><h4>Resources and workforce</h4>' +
        '<p>Balances, budgets, and people at the last refresh.</p></div></div>' +
        '<div class="stats-grid">' +
            statisticsTile('Company funds', 'funds', '', 'Current balance, not profit', 'money') +
            statisticsTile('Company value', 'value', '', 'Reported company value', 'money') +
            statisticsTile('Advertising budget', 'advertisementBudget', '', 'Reported advertising budget', 'money') +
            statisticsTile('Available trains', 'trains', '', 'Training opportunities') +
            positionStat('Employees', fmt(staff.length), 'From the loaded roster') +
            positionStat('Average effectiveness', fmt(result.avgEffectiveness), 'Included employees') +
            positionStat('Daily wage payroll', money(result.currentAll), 'All employees with known wages') +
            positionStat('Employee capacity', company && company.capacity ? fmt(company.capacity) : 'Not reported', 'Reported hiring slots') +
        '</div>';
    html += '<div class="positions-section-head"><div><h4>Changes over time</h4>' +
        '<p>Compare tracked values against the earliest available baseline for the selected period.</p></div>' +
        '<button class="small" data-page="changes">Open Changes →</button></div>';
    if (history && history.metrics && history.metrics.length) {
        html += '<div class="stats-comparison-note">' + (history.partial ?
            'Partial history: some of the selected period has not yet been recorded.' :
            'Tracked comparison for the past ' + history.days + ' days.') +
            '</div><div class="stats-deltas">';
        history.metrics.filter(function (m) {
            return ['dailyIncome','weeklyIncome','avgEffectiveness','employeeCount',
                'efficiency','popularity','environment','payroll',
                'employeeCapacity','avgWorkingStatEffectiveness','managementBonusPoints'].indexOf(m.key) >= 0;
        }).forEach(function (m) {
            var change = m.kind === 'money' ? money(m.delta) : fmt(m.delta);
            html += '<div><small>' + esc(m.label) + '</small><strong>' +
                esc((m.delta > 0 ? '+' : '') + change) + '</strong>' +
                '<span>From ' + esc(metricText(m.previous, m.kind)) + ' to ' +
                esc(metricText(m.latest, m.kind)) + '</span></div>';
        });
        html += '</div>';
    } else {
        html += '<div class="stats-comparison-note">No earlier snapshot is available yet. ' +
            'Refresh on future days to build a comparison history.</div>';
    }
    return html + '<p class="stats-footnote">Position and wage advice is available in its own section. ' +
        'History is device-local and may be partial. All reported numbers are for reference only.</p></section>';
}

function employeesPage(result, visibleRows) {
    var html = '<section class="workspace employee-page">' +
        '<div class="page-heading employees-heading"><div><small>Employee recommendations</small><h3>Employee pay details</h3><p>Search employees, review pay changes, and copy individual wage recommendations.</p></div><button class="small" data-a="reset-inclusions">Include all</button></div>' +
        '<div class="toolbar">' +
            '<div class="search"><span>⌕</span><input data-ui="query" value="' + esc(ui.query) + '" placeholder="Search name, ID, or position" aria-label="Search employees"></div>' +
            '<select data-ui="sort" aria-label="Sort employees">' + sortOptions() + '</select>' +
            '<button class="small" data-a="sort-dir" title="Toggle sort direction">' + (ui.direction === 'desc' ? '↓' : '↑') + '</button>' +
        '</div>' +
        '<div class="filters">' + filterButton('all', 'All', result.rows.length) + filterButton('included', 'Included', result.included) + filterButton('excluded', 'Excluded', result.excluded) + filterButton('raise', 'Raises', result.rows.filter(function(x){return !x.omit&&x.change>0;}).length) + filterButton('cut', 'Cuts', result.rows.filter(function(x){return !x.omit&&x.change<0;}).length) + '</div>' +
        '<div class="table-meta"><span>Showing <b>' + fmt(visibleRows.length) + '</b> of ' + fmt(result.rows.length) + '</span><span>Tap a name to see full employee details.</span></div>' +
        '<div class="table-wrap"><table class="employee-table"><thead><tr>' +
            '<th class="use-col">Use</th><th class="employee-col">Employee</th><th class="position-col">Position</th><th class="effect-col">Eff.</th><th class="current-col">Current</th><th class="suggested-col">Suggested</th><th class="change-col">Change</th><th class="action-col"></th>' +
        '</tr></thead><tbody>';

    visibleRows.forEach(function (x) {
        var review = '<small>Fit ' + fmt(x.currentFit) + '</small>';
        html += '<tr class="' + (x.omit ? 'excluded-row' : '') + '">' +
            '<td class="use-col"><input type="checkbox" data-inc="' + esc(x.id) + '"' + (!x.omit ? ' checked' : '') + ' aria-label="Include ' + esc(x.name) + '"></td>' +
            '<td class="employee-col"><button class="employee-link" data-detail="' + esc(x.id) + '">' + esc(x.name) + '</button><small class="employee-position">' + esc(x.position) + '</small><small class="employee-id">[' + esc(x.id) + ']</small></td>' +
            '<td class="position-col"><b>' + esc(x.position) + '</b>' + review + '</td>' +
            '<td class="effect-col"><b>' + fmt(x.effectiveness.total) + '</b><small>Fit ' + fmt(x.currentFit) + '</small></td>' +
            '<td class="current-col">' + (x.wage == null ? '<span class="subtle">—</span>' : money(x.wage)) + '</td>' +
            '<td class="suggested-col suggested"><b>' + money(x.suggested) + '</b><small class="mobile-status">' + changeLabel(x) + '</small></td>' +
            '<td class="change-col ' + (x.change > 0 ? 'positive' : x.change < 0 ? 'negative' : '') + '"><b>' + (x.change > 0 ? '+' : '') + money(x.change) + '</b>' + (x.wage > 0 && x.change ? '<small>' + (x.changePct > 0 ? '+' : '') + pct(x.changePct) + '</small>' : '<small>' + changeLabel(x) + '</small>') + '</td>' +
            '<td class="action-col"><button class="row-action" data-copy-one="' + esc(x.id) + '" title="Copy suggested wage">⧉</button></td>' +
        '</tr>';
    });

    if (!visibleRows.length) html += '<tr><td colspan="8" class="no-results">No employees match this view.</td></tr>';
    html += '</tbody></table></div></section>';
    return html;
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

    panel.querySelectorAll('[data-change-range]').forEach(function (b) {
        b.onclick = function () {
            changeRange = String(b.dataset.changeRange || '7');
            put('changeRange', changeRange);
            render();
        };
    });
    panel.querySelectorAll('[data-save-reason]').forEach(function (button) {
        button.onclick = function () {
            if (!company || !company.id) return;
            var id = button.dataset.saveReason;
            var input = Array.from(panel.querySelectorAll('[data-reason-id]')).find(function (node) {
                return node.dataset.reasonId === id;
            });
            if (!input) return;
            var history = readChangeHistory(company.id);
            var reason = String(input.value || '').trim().slice(0, 300);
            if (reason) history.reasons[id] = reason;
            else delete history.reasons[id];
            put(changeStorageKey(company.id), history);
            render();
            toast(reason ? 'Dismissal note saved on this device.' : 'Dismissal note cleared.', true);
        };
    });
    panel.querySelectorAll('[data-a="copy-changes"]').forEach(function (b) {
        b.onclick = function () {
            copyText(changeReportText(changeReport()))
                .then(function () { toast('Company change report copied.', true); })
                .catch(function () { toast('Unable to copy report.', false); });
        };
    });

    panel.querySelectorAll('[data-use-new-role]').forEach(function (button) {
        button.onclick = function () {
            if (!useAdditionalRolePlan(button.dataset.useNewRole)) {
                toast('The staffing scenario is no longer available. Refresh company data.', false);
                return;
            }
            ui.page = 'positions';
            detailId = '';
            render();
            toast('Exploratory staffing targets saved. No Torn position was changed.', true);
        };
    });

    panel.querySelectorAll('[data-page]').forEach(function (b) {
        b.onclick = function () {
            ui.page = b.dataset.page || 'dashboard';
            ui.filter = ui.page === 'wages' ? ui.filter : 'all';
            detailId = '';
            render();
        };
    });

    panel.querySelectorAll('[data-filter-jump]').forEach(function (b) {
        b.onclick = function () {
            ui.filter = b.dataset.filterJump || 'all';
            ui.page = 'wages';
            render();
        };
    });

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

    var resetStaffing = panel.querySelector('[data-a="reset-staffing"]');
    if (resetStaffing) resetStaffing.onclick = function () {
        resetStaffingPlan();
        toast('Staffing targets reset to current position counts.', true);
        render();
    };

    panel.querySelectorAll('[data-staffing-target]').forEach(function (input) {
        input.onchange = function () {
            saveStaffingTarget(input.dataset.staffingTarget, input.value);
            render();
        };
    });

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

    var filterStrip = panel.querySelector('.filters');
    if (filterStrip) {
        filterStrip.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                filterStrip.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive:false });
    }

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


function autoSyncIsAllowed() {
    return cfg.autoRefresh !== false && !!apiKey() && isOwnCompanyView() &&
        document.visibilityState !== 'hidden';
}

function autoSyncLog() {
    var state = get('autoSyncState', {});
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function autoSyncStatusText() {
    if (cfg.autoRefresh === false) return 'Auto-recording is off. Enable it in Settings.';
    if (!apiKey()) return 'Auto-recording needs a Torn API key.';
    if (!isOwnCompanyView()) return 'Auto-recording is available when you visit your own company page.';
    var log = autoSyncLog();
    if (log.lastError && log.lastAttempt &&
        Date.now() - log.lastAttempt < AUTO_SYNC_FAILURE_BACKOFF) {
        return 'Automatic recording could not refresh; retrying later. Manual Refresh is available.';
    }
    return 'Auto-recording is on' +
        (lastLoadedAt ? ' · Last saved ' + nowText(lastLoadedAt) : ' · Waiting for your first company visit') +
        '. It works while this company page is open and visible.';
}

function renderAutoSyncIfVisible() {
    if (!S || !S.querySelector) return;
    var overlay = S.querySelector('#overlay');
    if (!overlay || !overlay.classList.contains('show')) return;
    // Do not discard edits in progress during an automatic refresh.
    var focused = S.activeElement;
    if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName || '')) return;
    render();
}

function scheduleAutoCompanySync(reason, delayMs) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(function () {
        autoSyncTimer = 0;
        runAutoCompanySync(reason || 'periodic');
    }, Math.max(0, Number(delayMs) || 0));
}

async function runAutoCompanySync(reason) {
    if (!autoSyncIsAllowed() || busy) return false;
    var now = Date.now();
    var log = autoSyncLog();
    var gap = reason === 'company-action' ? AUTO_SYNC_CHANGE_GAP :
        reason === 'periodic' ? AUTO_SYNC_INTERVAL : AUTO_SYNC_VISIT_GAP;
    var companyId = company && company.id || '';
    var sameCompany = !log.companyId || !companyId || String(log.companyId) === String(companyId);
    if (sameCompany && now - Number(log.lastAttempt || 0) < gap) return false;
    if (sameCompany && log.lastError &&
        now - Number(log.lastAttempt || 0) < AUTO_SYNC_FAILURE_BACKOFF) return false;

    // Soft cross-tab lease to avoid duplicate API requests.
    var lease = get('autoSyncLease', {});
    if (lease && lease.owner !== autoSyncOwner && num(lease.expires) > now) return false;
    put('autoSyncLease', { owner:autoSyncOwner, expires:now + AUTO_SYNC_LEASE_MS });
    var verified = get('autoSyncLease', {});
    if (!verified || verified.owner !== autoSyncOwner) return false;

    put('autoSyncState', {
        lastAttempt:now, lastSuccess:num(log.lastSuccess), companyId:companyId,
        reason:reason, lastError:''
    });
    busy = true;
    renderAutoSyncIfVisible();
    try {
        await fetchAll();
        put('autoSyncState', {
            lastAttempt:now, lastSuccess:Date.now(),
            companyId:company && company.id || companyId,
            reason:reason, lastError:''
        });
        return true;
    } catch (err) {
        put('autoSyncState', {
            lastAttempt:now, lastSuccess:num(log.lastSuccess),
            companyId:companyId, reason:reason,
            lastError:String(err && err.message || 'Unable to refresh').slice(0, 140)
        });
        return false;
    } finally {
        busy = false;
        var ownedLease = get('autoSyncLease', {});
        if (ownedLease && ownedLease.owner === autoSyncOwner) remove('autoSyncLease');
        renderAutoSyncIfVisible();
    }
}

function observeAutoCompanyRoute() {
    var route = location.pathname + location.search;
    if (autoSyncRoute === route) return;
    autoSyncRoute = route;
    if (!isOwnCompanyView()) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = 0;
        return;
    }
    scheduleAutoCompanySync('company-visit', 700);
}

function companyActionElement(target) {
    if (!target || target.nodeType !== 1 || !isOwnCompanyView()) return null;
    if ((host && host.contains(target)) || (launcher && launcher.contains(target))) return null;
    var action = target.closest && target.closest('button,input[type="submit"],[role="button"],a');
    if (!action || action.disabled) return null;
    var label = String(action.textContent || action.value || action.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
    return /\b(save|update|apply|hire|fire|dismiss|remove|assign|promote|demote|train|advertis(?:e|ing|ement)?|upgrade|change|confirm|submit|purchase|buy|sell|transfer|deposit|withdraw|increase|decrease|start|stop|set)\b/i.test(label) ?
        action : null;
}

function installAutoCompanyRecording() {
    observeAutoCompanyRoute();

    // Wait briefly after Torn interactions, then read the actual API state;
    // a click is never treated as proof that a change succeeded.
    document.addEventListener('click', function (event) {
        if (autoSyncIsAllowed() && companyActionElement(event.target))
            scheduleAutoCompanySync('company-action', 4500);
    }, true);
    document.addEventListener('submit', function (event) {
        var form = event.target;
        if (autoSyncIsAllowed() && form && !(host && host.contains(form)))
            scheduleAutoCompanySync('company-action', 4500);
    }, true);
    document.addEventListener('change', function (event) {
        var element = event.target;
        if (!autoSyncIsAllowed() || !element || (host && host.contains(element))) return;
        if (element.matches && element.matches('select,input[type="number"],input[type="checkbox"]'))
            scheduleAutoCompanySync('company-action', 6000);
    }, true);

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && isOwnCompanyView())
            scheduleAutoCompanySync('return-to-company', 800);
    });
    window.addEventListener('focus', function () {
        if (isOwnCompanyView()) scheduleAutoCompanySync('return-to-company', 1200);
    });
    window.addEventListener('popstate', observeAutoCompanyRoute);
    window.addEventListener('hashchange', observeAutoCompanyRoute);
    setInterval(function () {
        observeAutoCompanyRoute();
        if (autoSyncIsAllowed()) scheduleAutoCompanySync('periodic', 100);
    }, AUTO_SYNC_INTERVAL);

    // Share refreshed cached company data across tabs without another request.
    window.addEventListener('storage', function (event) {
        if (event.key === PFX + 'cache' && !busy && restoreCache())
            renderAutoSyncIfVisible();
        else if (event.key && event.key.indexOf(PFX + 'changeHistory:') === 0 && !busy)
            renderAutoSyncIfVisible();
    });
}

async function load() {
    if (busy) return;
    busy = true;
    errorState = null;
    render();
    try {
        await fetchAll();
        var existingSync = autoSyncLog();
        put('autoSyncState', {
            lastAttempt:Date.now(), lastSuccess:Date.now(),
            companyId:company && company.id || existingSync.companyId || '',
            reason:'manual', lastError:''
        });
        toast('Company data refreshed and recorded.', true);
    } catch (e) {
        errorState = e;
    } finally {
        busy = false;
        render();
    }
}

function openPanel() {
    S.querySelector('#overlay').classList.add('show');
    if (typeof refreshLauncherVisibility === 'function') refreshLauncherVisibility();
    if (!ui.page) ui.page = 'dashboard';
    render();
    if (autoSyncIsAllowed()) scheduleAutoCompanySync('panel-open', 300);
}

function closePanel() {
    detailId = '';
    S.querySelector('#overlay').classList.remove('show');
    if (typeof scheduleLauncherVisibility === 'function') scheduleLauncherVisibility();
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
    if (typeof refreshLauncherVisibility === 'function') refreshLauncherVisibility();
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
    // A new key should not inherit the failed-key auto-sync backoff.
    remove('autoSyncState');
    box.classList.remove('show');
    if (typeof scheduleLauncherVisibility === 'function') scheduleLauncherVisibility();
    errorState = null;
    toast('API key saved for ' + (remember.checked ? 'this device.' : 'this session.'), true);
    render();
    if (isOwnCompanyView() && cfg.autoRefresh) scheduleAutoCompanySync('company-visit', 300);
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
    var headers = ['Employee','Torn ID','Included','Current Position','Staffing-Aware Suggested Position','Pure Stat-Best Position','MAN','INT','END','Work-Stat Efficiency','Total Effectiveness','Score','Current Wage','Suggested Wage','Change'];
    var lines = [headers].concat(data.map(function (x) {
        return [x.name,x.id,x.omit?'No':'Yes',x.position,x.bestPosition?x.bestPosition.name:'',x.statBestPosition?x.statBestPosition.name:'',x.manual,x.intelligence,x.endurance,x.currentFit,x.effectiveness.total,x.omit?'':x.score.toFixed(3),x.wage == null ? '' : x.wage,x.suggested,x.change];
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
        if (saved && isFinite(Number(saved.x)) && isFinite(Number(saved.y))) place(saved.x, saved.y);
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
':host{all:initial;--bg:#111417;--panel:#171b1f;--panel2:#1d2329;--panel3:#242b32;--border:#37414a;--border2:#4a5661;--text:#f3f6f8;--muted:#9ba8b3;--green:#22c77a;--green2:#0d6c47;--red:#ff6b6b;--amber:#f2b84b;--blue:#76c7ff;font-family:Inter,Arial,sans-serif;color:var(--text)}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}#fab{position:fixed;right:14px;bottom:100px;width:50px;height:50px;border-radius:16px;border:1px solid #5ccf94;background:linear-gradient(145deg,#0b6a45,#0a5037);color:#fff;z-index:2147483645;box-shadow:0 10px 25px #0008;font-weight:900;font-size:13px;letter-spacing:.4px;touch-action:none}#fab::after{content:"$";position:absolute;right:-5px;top:-6px;width:19px;height:19px;border-radius:50%;display:grid;place-items:center;background:#e9fff4;color:#075535;font-size:12px;border:2px solid #075535}#overlay{display:none;position:fixed;inset:0;background:#080a0ccc;z-index:2147483646;overflow:auto;color:var(--text);-webkit-text-fill-color:initial}#overlay.show{display:block}#panel{width:min(1180px,calc(100vw - 20px));min-height:calc(100vh - 20px);margin:10px auto;background:var(--bg);border:1px solid var(--border2);border-radius:16px;overflow:hidden;box-shadow:0 24px 70px #000b}header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:#0b0e11eF;border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}.brand{display:flex;align-items:center;gap:11px;min-width:0}.logo{width:42px;height:42px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(180deg,#153025,#0d2219);border:1px solid #2f8f62;box-shadow:inset 0 1px 0 #5fd79a22}.brand-logo{width:30px;height:30px;display:block}.brand h2{margin:0;font-size:16px;line-height:1.2;color:var(--text)}.brand h2 span{color:var(--muted);font-size:11px;font-weight:700}.brand p{margin:3px 0 0;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw}.header-actions{display:flex;align-items:center;gap:9px}.refresh-state{font-size:11px;color:#a9e6c8}.refresh-state.stale{color:var(--amber)}.icon-btn{width:34px;height:34px;padding:0;border-radius:9px;border:1px solid var(--border2);background:var(--panel2);color:#fff!important;font-size:20px}.page-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;background:#101418;border-bottom:1px solid var(--border)}.page-tab{min-width:0;padding:11px 14px;border:0;border-right:1px solid var(--border);background:transparent;color:var(--muted)!important;text-align:left}.page-tab:last-child{border-right:0}.page-tab-main{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:900}.page-tab-main b{min-width:22px;padding:2px 6px;border-radius:999px;background:#2b333a;color:#cfd8df;font-size:9px;text-align:center}.page-tab small{display:block;margin-top:2px;font-size:9px;color:#74818b}.page-tab.active{background:#163226;color:#c9f5dd!important;box-shadow:inset 0 -3px 0 #39c989}.page-tab.active small{color:#9ec7b2}.actionbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--border)}.actionbar button,.settings button,.empty button,.toolbar button,.page-heading button,.insight-head button,.overview-help button{border:1px solid var(--border2);border-radius:9px;padding:8px 11px;background:var(--panel3);color:var(--text)!important;font-weight:750}.actionbar .primary,.empty .primary{background:var(--green2);border-color:#2f9d70}.spinner{display:inline-block;width:12px;height:12px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:5px}@keyframes spin{to{transform:rotate(360deg)}}.settings{padding:14px;background:#14191e}.settings-page{min-height:55vh}.page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:14px}.page-heading>div{min-width:0}.page-heading>div>small{display:block;color:#69d49f;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.7px}.page-heading h3{margin:3px 0 3px;font-size:18px}.page-heading p{margin:0;max-width:720px;color:var(--muted);font-size:10px;line-height:1.45}.page-heading .compact{white-space:nowrap}.settings-group{margin:0 14px 12px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.settings-group-title{margin-bottom:10px}.settings-group-title b,.settings-group-title small{display:block}.settings-group-title b{font-size:12px}.settings-group-title small{margin-top:2px;color:var(--muted);font-size:9px}.section-title{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:12px}.section-title h3{margin:0;font-size:15px}.section-title p{margin:3px 0 0;color:var(--muted);font-size:11px}.text-btn{padding:5px 8px!important;background:transparent!important;color:var(--blue)!important}.settings-grid{display:grid;grid-template-columns:repeat(3,minmax(190px,1fr));gap:10px}.setting{display:block;padding:10px;border:1px solid var(--border);background:var(--panel);border-radius:10px}.setting>span{display:block;font-size:12px;font-weight:800;margin-bottom:6px}.setting input,.setting select{width:100%;height:38px;padding:7px 10px;border:1px solid #43515d;border-radius:8px;background:#10171b!important;color:#eef3f6!important;-webkit-text-fill-color:#eef3f6!important;outline:none;color-scheme:dark}.setting input:focus,.setting select:focus{border-color:#42c889;box-shadow:0 0 0 2px #42c88922}.setting select option{background:#10171b;color:#eef3f6}.setting small{display:block;color:var(--muted);font-size:10px;line-height:1.35;margin-top:6px}.toggles{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:8px;margin-top:10px}.toggle{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--panel);cursor:pointer}.toggle input{position:absolute;opacity:0}.switch{width:36px;height:20px;border-radius:999px;background:#4a535c;position:relative;flex:0 0 auto}.switch::after{content:"";position:absolute;width:14px;height:14px;top:3px;left:3px;border-radius:50%;background:white;transition:.15s}.toggle input:checked+.switch{background:var(--green2)}.toggle input:checked+.switch::after{left:19px}.toggle b,.toggle small{display:block}.toggle b{font-size:12px}.toggle small{margin-top:2px;color:var(--muted);font-size:10px;line-height:1.35}.error-card{display:grid;grid-template-columns:34px 1fr 28px;gap:10px;align-items:start;margin:12px 14px;padding:11px;border:1px solid #9d4b4b;background:#3d1c1f;border-radius:11px}.error-icon{width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:#7d2e34;font-weight:900}.error-card b{font-size:12px}.error-card p{margin:4px 0;font-size:11px;color:#ffd9d9}.error-card small{font-size:10px;line-height:1.4;color:#ffd9d9}.error-card>button{border:0;background:transparent;color:#fff;font-size:18px}.error-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.error-actions button,.error-actions a{display:inline-flex;align-items:center;padding:6px 8px;border-radius:7px;border:1px solid #a45d5d;background:#582a2d;color:#fff!important;text-decoration:none;font-size:10px;font-weight:800}.error-actions a{background:#272f36;border-color:#596672}.notice{margin:0 14px 10px;padding:9px 11px;background:#3b321b;border:1px solid #806b2f;border-radius:9px;color:#ffe3a0;font-size:11px}.empty{min-height:55vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px}.empty-icon{width:72px;height:72px;border-radius:22px;display:grid;place-items:center;background:#10261c;border:1px solid #2f8f62}.empty-logo{width:42px;height:42px;display:block}.empty h3{margin:14px 0 5px;font-size:18px}.empty p{max-width:520px;margin:0 0 14px;color:var(--muted);font-size:12px;line-height:1.55}.empty>div{display:flex;gap:8px}.overview-page{padding-bottom:14px}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:0 14px 12px}.summary-card{padding:11px;border:1px solid var(--border);border-radius:11px;background:linear-gradient(180deg,var(--panel2),var(--panel));min-width:0}.summary-card small,.summary-card b,.summary-card span{display:block}.summary-card small{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.45px}.summary-card b{margin-top:4px;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary-card span{margin-top:4px;color:var(--muted);font-size:10px}.summary-card.good b{color:#8ff0bd}.summary-card.warn b{color:#ffd27d}.insight-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;padding:0 14px 12px}.insight-card{min-width:0;border:1px solid var(--border);border-radius:12px;background:var(--panel);overflow:hidden}.insight-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-bottom:1px solid var(--border)}.insight-head b,.insight-head small{display:block}.insight-head b{font-size:11px}.insight-head small{margin-top:2px;color:var(--muted);font-size:9px}.insight-head button{border:0;background:transparent;color:var(--blue)!important;font-size:9px;font-weight:800}.insight-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border:0;border-bottom:1px solid #2b333a;background:transparent;color:var(--text)!important;text-align:left}.insight-row:last-child{border-bottom:0}.insight-row span{min-width:0}.insight-row b,.insight-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.insight-row b{font-size:10px}.insight-row small{margin-top:2px;color:var(--muted);font-size:8px}.insight-row strong{max-width:45%;font-size:10px;color:#bcefd3;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.insight-empty{padding:18px 10px;color:#9fcdb4;font-size:10px}.overview-help{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 14px;padding:12px;border:1px solid #365846;border-radius:11px;background:#13281f}.overview-help b{font-size:11px}.overview-help p{margin:3px 0 0;color:#a9b9b0;font-size:9px;line-height:1.45}.overview-help button{flex:0 0 auto;border:1px solid #4d765f;border-radius:8px;padding:7px 9px;background:#1b372a;color:#c9f5dd!important;font-weight:800}.workspace{padding:0 14px 16px}.employee-page>.page-heading{padding-left:0;padding-right:0}.toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 8px}.search{flex:1 1 290px;display:flex;align-items:center;gap:6px;height:38px;padding:0 10px;border:1px solid var(--border2);border-radius:9px;background:var(--panel)}.search span{color:var(--muted);font-size:18px}.search input{width:100%;border:0;outline:0;background:transparent!important;color:var(--text)!important;-webkit-text-fill-color:var(--text)!important}.toolbar select{height:38px;padding:0 9px;border:1px solid var(--border2);border-radius:9px;background:var(--panel3)!important;color:var(--text)!important;-webkit-text-fill-color:var(--text)!important}.toolbar .small{height:38px}.filters{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;max-width:100%;padding:0 0 6px;margin-bottom:6px;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;touch-action:pan-x;scrollbar-width:none;scroll-snap-type:x proximity}.filters::-webkit-scrollbar{display:none}.filter{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:7px 10px;border-radius:999px;border:1px solid var(--border);background:var(--panel);color:var(--muted);white-space:nowrap;touch-action:pan-x;scroll-snap-align:start}.filter span{min-width:20px;padding:2px 5px;border-radius:999px;background:#2c343c;font-size:9px;text-align:center}.filter.active{background:#123829;border-color:#2e8b64;color:#bdf4d6}.table-meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:10px;padding:7px 2px}.table-wrap{width:100%;overflow:hidden;border:1px solid var(--border);border-radius:12px;background:var(--panel);max-height:66vh}.employee-table{width:100%;min-width:0;table-layout:fixed;border-collapse:collapse;font-size:11px}.employee-table th,.employee-table td{padding:10px 8px;border-bottom:1px solid #303840;vertical-align:middle;text-align:right;background:var(--panel);color:var(--text)!important;overflow:hidden}.employee-table th{position:sticky;top:0;z-index:5;background:#0c1013!important;color:#cbd4db!important;font-size:9px;text-transform:uppercase;letter-spacing:.35px;white-space:nowrap}.employee-table tbody tr:nth-child(even) td{background:#151a1f}.employee-table .use-col{width:52px;text-align:center}.employee-table .employee-col{width:22%;text-align:left}.employee-table .position-col{width:23%;text-align:left}.employee-table .effect-col{width:10%}.employee-table .current-col{width:14%}.employee-table .suggested-col{width:15%}.employee-table .change-col{width:14%}.employee-table .action-col{width:46px;text-align:center}.employee-table .employee-col,.employee-table .position-col{white-space:nowrap;text-overflow:ellipsis}.employee-link{display:block;max-width:100%;padding:0;border:0;background:transparent;color:#9bd8ff!important;font-weight:850;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.employee-col small,.position-col small,.effect-col small,.suggested-col small,.change-col small{display:block;margin-top:3px;color:var(--muted);font-size:9px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.position-col b,.suggested-col b,.change-col b,.effect-col b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.position-col .attention{color:#ffd27d}.excluded-row td{opacity:.62}.suggested b{color:#b8f5d2}.positive{color:#8ff0bd!important}.negative{color:#ff9d9d!important}.tag{display:inline-flex;align-items:center;padding:3px 6px;border-radius:999px;font-size:8px;font-weight:800}.tag.raise{background:#123d2d;color:#9cf0c1}.tag.cut{background:#4a2226;color:#ffb1b1}.tag.keep{background:#293239;color:#ccd5dc}.tag.muted{background:#2b2e31;color:#9da6ad}.mobile-status{display:none!important}.row-action{width:28px;height:28px;padding:0;border-radius:7px;border:1px solid var(--border);background:#262e35;color:#fff!important}.subtle{color:var(--muted)}.no-results{text-align:center!important;padding:28px!important;color:var(--muted)!important}.staffing-empty{padding:12px;color:var(--muted);font-size:10px}.staffing-summary{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 12px 10px;padding:10px;border:1px solid var(--border);border-radius:10px;background:#11181c}.staffing-summary b,.staffing-summary small{display:block}.staffing-summary b{font-size:11px}.staffing-summary small{margin-top:2px;color:var(--muted);font-size:9px;line-height:1.4}.staffing-summary.valid{border-color:#315d48}.staffing-summary.invalid{border-color:#8a6330;background:#2a2112}.staffing-summary button{flex:0 0 auto;padding:7px 9px!important}.staffing-table{margin:0 12px 12px;border:1px solid var(--border);border-radius:10px;overflow:hidden}.staffing-head,.staffing-row{display:grid;grid-template-columns:minmax(0,1fr) 72px 90px;align-items:center;gap:8px;padding:8px 10px}.staffing-head{background:#0d1215;color:var(--muted);font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.4px}.staffing-row{border-top:1px solid #2c343b;background:var(--panel2)}.staffing-role{min-width:0}.staffing-role b,.staffing-role small{display:block}.staffing-role b{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.staffing-role small{margin-top:2px;color:#88bba2;font-size:8px}.staffing-current{text-align:center;font-size:11px;font-weight:800}.staffing-row input{width:100%;height:34px;padding:6px 8px;border:1px solid #43515d;border-radius:8px;background:#10171b!important;color:#eef3f6!important;-webkit-text-fill-color:#eef3f6!important;text-align:center;outline:none;color-scheme:dark}.staffing-row input:focus{border-color:#42c889;box-shadow:0 0 0 2px #42c88922}.staffing-reason{margin-top:8px;padding:9px 10px;border:1px solid #3b5548;border-radius:9px;background:#102019}.staffing-reason b{font-size:10px;color:#b8f5d2}.staffing-reason p{margin:4px 0 0;color:#a9b9b0;font-size:9px;line-height:1.45}.guide-page{padding-bottom:14px}.guide-settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0 14px 12px}.guide-settings>div{padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.guide-settings small,.guide-settings b{display:block}.guide-settings small{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.4px}.guide-settings b{margin-top:4px;font-size:12px}.guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0 14px}.guide-card{min-width:0;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.guide-card-head{display:flex;align-items:center;gap:8px}.guide-card-head>span{width:24px;height:24px;display:grid;place-items:center;border-radius:8px;background:#123829;border:1px solid #2e8b64;color:#bdf4d6;font-size:10px;font-weight:900}.guide-card h4{margin:0;font-size:12px}.guide-card>p{margin:8px 0;color:var(--muted);font-size:10px;line-height:1.5}.formula{max-width:100%;overflow-x:auto;padding:9px 10px;border:1px solid #2c3942;border-radius:9px;background:#0b1114;color:#b8f5d2;font:700 10px monospace;white-space:nowrap;-webkit-overflow-scrolling:touch}.guide-sample{margin-top:9px;padding:9px;border-left:3px solid #39c989;border-radius:0 8px 8px 0;background:#102019}.guide-sample b{font-size:10px}.guide-sample p{margin:4px 0 0;color:#aab8b0;font-size:10px;line-height:1.45}.guide-note{margin:12px 14px 0;padding:10px 12px;border:1px solid #486153;border-radius:10px;background:#13221b;color:#c5ddd0;font-size:10px;line-height:1.45}.employee-position{display:none!important;color:#c3cdd4!important;font-weight:700}.employee-id{color:#77858f!important}footer{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--border);color:var(--muted);font-size:9px;background:#0f1316}.detail-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:14px;background:#050607cc}.detail-shell{width:min(680px,100%);max-height:90vh;overflow:auto}.detail-card{border:1px solid var(--border2);border-radius:14px;background:#14191e;box-shadow:0 20px 60px #000c;padding:14px}.detail-head{display:flex;justify-content:space-between;gap:10px}.detail-head small{color:var(--muted);font-size:10px;text-transform:uppercase}.detail-head h3{margin:3px 0 0;font-size:18px}.detail-head h3 span{color:var(--muted);font-size:11px}.detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:12px}.detail-grid>div{padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}.detail-grid small,.detail-grid b{display:block}.detail-grid small{color:var(--muted);font-size:9px}.detail-grid b{margin-top:3px;font-size:13px}.detail-card h4{margin:14px 0 7px;font-size:11px;text-transform:uppercase;color:#c6d1d9}.breakdown{display:grid;grid-template-columns:repeat(2,1fr);gap:5px}.breakdown>div{display:flex;justify-content:space-between;padding:7px 8px;border-radius:8px;background:var(--panel);font-size:10px}.breakdown .pos{color:#9cf0c1}.breakdown .neg{color:#ff9d9d}.position-box{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px;border:1px solid #35694f;background:#123024;border-radius:9px}.position-box b,.position-box small{display:block}.position-box small{margin-top:3px;color:#a9c7b9;font-size:9px}.position-box strong{font-size:20px;color:#baf2d2}.requirements{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;font-size:9px;color:var(--muted)}.requirements b{padding:3px 6px;border-radius:6px;background:#252e35;color:#dce4e9}.detail-note{margin:12px 0 0;color:var(--muted);font-size:9px;line-height:1.45}#keybox{display:none;position:fixed;inset:0;z-index:2147483647;background:#050607dd;align-items:center;justify-content:center;padding:14px}#keybox.show{display:flex}.key-card{width:min(460px,100%);padding:15px;border:1px solid var(--border2);border-radius:14px;background:#151a1f;color:var(--text)}.key-card h3{margin:0;font-size:16px}.key-card p{margin:5px 0 10px;color:var(--muted);font-size:10px;line-height:1.45}.key-card input[type=password]{width:100%;height:39px;padding:8px 10px;border:1px solid #43515d;border-radius:8px;background:#10171b!important;color:#eef3f6!important;-webkit-text-fill-color:#eef3f6!important;outline:none;color-scheme:dark}.key-card input[type=password]:focus{border-color:#42c889;box-shadow:0 0 0 2px #42c88922}.remember{display:flex;align-items:center;gap:7px;margin-top:9px;color:#d3dce3;font-size:10px}.key-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:12px;flex-wrap:wrap}.key-actions button{padding:8px 10px;border-radius:8px;border:1px solid var(--border2);background:var(--panel3);color:#fff!important;font-weight:800}.key-actions .save{background:var(--green2)}#toast{position:fixed;left:50%;bottom:28px;z-index:2147483647;transform:translate(-50%,18px);opacity:0;pointer-events:none;padding:9px 12px;border-radius:9px;color:#fff;font:800 11px Arial;box-shadow:0 8px 25px #000b;transition:.18s}#toast.show{opacity:1;transform:translate(-50%,0)}#toast.ok{background:#0b6947}#toast.bad{background:#7d2e34}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #82d9ff;outline-offset:2px}@media(max-width:1000px){.guide-grid{grid-template-columns:1fr}.guide-settings{grid-template-columns:repeat(2,minmax(0,1fr))}.employee-position{display:block!important}.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.insight-grid{grid-template-columns:1fr 1fr}.insight-card:last-child{grid-column:1/-1}.settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.employee-table .position-col{display:none}.employee-table .employee-col{width:29%}.employee-table .effect-col{width:12%}.employee-table .current-col{width:17%}.employee-table .suggested-col{width:20%}.employee-table .change-col{width:18%}}@media(max-width:700px){.staffing-head,.staffing-row{grid-template-columns:minmax(0,1fr) 58px 78px}.staffing-summary{align-items:flex-start}.guide-settings{grid-template-columns:1fr 1fr;padding:0 10px 10px}.guide-grid{padding:0 10px}.guide-note{margin-left:10px;margin-right:10px}#panel{width:100vw;min-height:100vh;margin:0;border-radius:0;border-left:0;border-right:0}.brand p{max-width:50vw}.refresh-state{display:none}.page-tabs{position:sticky;top:67px;z-index:18}.page-tab{padding:9px 8px;text-align:center}.page-tab-main{justify-content:center;font-size:11px}.page-tab small{display:none}.actionbar{grid-template-columns:repeat(2,minmax(0,1fr));padding:8px;gap:6px}.actionbar button{padding:8px 6px;font-size:10px}.page-heading{padding:12px 10px}.page-heading h3{font-size:16px}.page-heading p{font-size:10px}.summary{grid-template-columns:repeat(2,minmax(0,1fr));padding:0 10px 10px}.summary-card{padding:9px}.summary-card b{font-size:15px}.insight-grid{grid-template-columns:1fr;padding:0 10px 10px}.insight-card:last-child{grid-column:auto}.overview-help{margin:0 10px;align-items:flex-start;flex-direction:column}.workspace{padding:0 8px 10px}.employees-heading{padding:10px 0}.toolbar{display:grid;grid-template-columns:1fr auto}.search{grid-column:1/-1;min-width:0}.toolbar select{min-width:0;width:100%}.table-meta span:last-child{display:none}.table-wrap{max-height:68vh}.employee-table .current-col{display:none}.employee-table .employee-col{width:36%}.employee-table .effect-col{width:16%}.employee-table .suggested-col{width:26%}.employee-table .change-col{width:22%}.employee-table th,.employee-table td{padding:8px 5px;font-size:10px}.employee-table th{font-size:8px}.employee-table .tag{display:none}.employee-table .mobile-status{display:block!important}.employee-table .row-action{width:24px;height:26px;font-size:10px}.settings-group{margin:0 9px 10px;padding:10px}.settings-grid,.toggles{grid-template-columns:1fr}.detail-grid{grid-template-columns:repeat(2,1fr)}footer{flex-direction:column}}@media(max-width:430px){.page-tab-main b{display:none}.summary{grid-template-columns:1fr 1fr}.summary-card small{font-size:8px}.summary-card span{font-size:8px}.employee-table .effect-col{display:none}.employee-table .employee-col{width:42%}.employee-table .suggested-col{width:32%}.employee-table .change-col{width:26%}.employee-table .change-col small{display:none}.breakdown{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr 1fr}}' +
'</style>' +

'<style>' +
'.role-opportunities{margin:0 14px 16px;padding:13px;border:1px solid #456070;border-radius:12px;background:#151e25}.role-opportunities-intro{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:11px}.role-opportunities-intro small{display:block;color:#86c7f2;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.5px}.role-opportunities-intro h4{margin:3px 0 4px;font-size:14px;color:#f0f6fa}.role-opportunities-intro p{margin:0;color:#b9cbd6;font-size:10px;line-height:1.55}.role-opportunities-intro>button{flex:0 0 auto;border:1px solid #48677a;background:#243946;border-radius:8px;color:#d4edff!important;font-size:10px;font-weight:800;padding:8px}.role-opportunity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.role-opportunity{min-width:0;padding:12px;border:1px solid #3a4a54;border-radius:10px;background:#1c2730}.role-opportunity-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px}.role-opportunity-head small{display:block;color:#9cb0bc;font-size:9px}.role-opportunity-head h5{margin:2px 0;color:#edf6fc;font-size:13px}.role-type{padding:4px 6px;border:1px solid #496d74;border-radius:999px;color:#a5e6db;font-size:9px;font-weight:850}.role-opportunity p{margin:6px 0;color:#bdcdd6;line-height:1.5;font-size:10px}.role-opportunity p b{color:#e7f3ff}.role-opportunity p.role-positive{color:#9ff1c1}.role-opportunity p.role-caution,.role-opportunity .role-caution{color:#ffd39b}.role-opportunity p.role-recovery{padding:8px 9px;border:1px solid #8d6d2e;border-radius:8px;background:#332817;color:#ffe0a3}.role-opportunity p.role-recovery b{color:#fff0c5}.role-opportunity>button{margin-top:8px;width:100%;padding:9px;border:1px solid #3f9c73;border-radius:8px;background:#174634;color:#c6f7de;font-size:10px;font-weight:800}.role-opportunity-empty{grid-column:1/-1;margin:0;padding:12px;color:#a9becb;font-size:11px}.role-opportunity-disclaimer{margin:11px 0 0;color:#a9bcc7;font-size:9px;line-height:1.55}@media(max-width:700px){.role-opportunities{margin-left:10px;margin-right:10px;padding:10px}.role-opportunities-intro{flex-direction:column;align-items:stretch}.role-opportunities-intro>button{align-self:flex-start}.role-opportunity-grid{grid-template-columns:1fr}}' +
'.support-impact{margin:0 14px 14px;padding:12px;border-radius:11px;border:1px solid #37644d;background:#13281f}.support-impact-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}.support-impact-head small{display:block;font-size:9px;text-transform:uppercase;color:#9bd8b5;letter-spacing:.4px}.support-impact-head h4{margin:4px 0;font-size:13px}.support-impact-head>b{font-size:10px}.support-impact p{margin:6px 0 0;color:#bfd6ca;font-size:10px;line-height:1.5}.support-risk{margin-top:10px;padding:10px;border:1px solid #9e7230;border-radius:9px;background:#382b1b;color:#ffe3ac;font-size:10px}.support-risk p{color:#ffe3ac}.support-risk ul{margin:6px 0 0;padding-left:16px;line-height:1.5}.staffing-reason.caution{background:#382b1b;border-color:#9e7230}.staffing-reason.caution b{color:#ffe3ac}@media(max-width:700px){.support-impact{margin-left:10px;margin-right:10px}}' +
'.changes-reason-editor{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 0}.changes-reason-editor input{flex:1 1 180px;min-width:0;padding:7px 9px;border:1px solid var(--border2);border-radius:7px;background:#10171b;color:var(--text);font-size:10px}.changes-reason-editor button{padding:7px 9px;border:1px solid #317c57;border-radius:7px;background:#1b4933;color:#c2f4da;font-size:10px;font-weight:850}.changes-page{padding:0 0 16px}.changes-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin:0 14px 12px}.changes-ranges{display:flex;flex-wrap:wrap;gap:5px}.changes-ranges button,.changes-copy{border:1px solid var(--border2);border-radius:8px;padding:8px 11px;background:var(--panel2);color:var(--text)!important;font-size:11px;font-weight:800}.changes-ranges button.selected{border-color:#2eaa76;background:#153e2b;color:#baf2d2!important}.changes-copy{background:var(--green2);border-color:#2eaa76}.changes-coverage{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;margin:0 14px 10px;padding:10px 12px;background:#13281f;border:1px solid #2e654b;border-radius:10px;font-size:11px}.changes-coverage b{color:#c2f4da}.changes-coverage span{font-size:10px;color:#afc6b9}.changes-notice{margin-top:8px}.changes-section-head{display:flex;justify-content:space-between;align-items:end;flex-wrap:wrap;gap:6px;margin:16px 14px 9px}.changes-section-head h4{margin:0;font-size:13px}.changes-section-head small{color:var(--muted);font-size:9px}.changes-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 14px}.changes-metric{min-width:0;padding:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px}.changes-metric small,.changes-metric strong,.changes-metric span{display:block}.changes-metric small{font-size:10px;color:var(--muted)}.changes-metric strong{margin-top:4px;font-size:17px;overflow-wrap:anywhere}.changes-metric span{margin-top:4px;font-size:10px;color:#b2bbc2}.changes-metric span.up{color:#8ff0bd}.changes-metric span.down{color:#ffb0b0}.changes-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 14px 10px}.changes-counts>div{padding:11px;background:#1c252b;border:1px solid var(--border);border-radius:9px;text-align:center}.changes-counts b,.changes-counts small{display:block}.changes-counts b{font-size:20px}.changes-counts small{color:var(--muted);font-size:10px}.changes-timeline,.changes-employee-list{margin:0 14px;background:var(--panel);border:1px solid var(--border);border-radius:11px;overflow:hidden}.changes-event{display:flex;gap:12px;padding:12px;border-bottom:1px solid var(--border);align-items:start}.changes-event:last-child,.changes-employee-row:last-child{border-bottom:none}.changes-event-tag{flex:0 0 86px;text-align:center;border:1px solid #5e6873;border-radius:5px;padding:5px 3px;color:#e0e5e9;font-size:9px;font-weight:850}.changes-event-tag.joined{color:#aaf1ce;border-color:#387b58;background:#133c2b}.changes-event-tag.fired{color:#ffc0bd;border-color:#8d4849;background:#432023}.changes-event-tag.left,.changes-event-tag.unconfirmed{color:#ffe2a0;border-color:#8d7138;background:#3e321d}.changes-event-content{min-width:0}.changes-event-content b{display:block;font-size:11px;line-height:1.5;font-weight:650;overflow-wrap:anywhere}.changes-event-content p{margin:5px 0;color:#ffccbd;font-size:10px}.changes-event-content small{display:block;margin-top:6px;color:var(--muted);font-size:9px}.changes-empty{margin:0 14px;padding:18px 12px;background:var(--panel);border:1px dashed var(--border2);border-radius:10px;color:var(--muted);font-size:11px;line-height:1.5}.changes-empty h4{margin:0 0 5px;color:var(--text);font-size:13px}.changes-empty p{margin:0}.changes-employee-row{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);font-size:11px}.changes-employee-row>span{font-weight:800;min-width:0}.changes-employee-row small{display:block;margin-top:3px;color:var(--muted);font-size:9px}.changes-employee-row>b{font-size:10px;font-weight:650;text-align:right;overflow-wrap:anywhere}.changes-overflow{margin:6px 14px;font-size:10px;color:var(--amber)}.changes-footnote{margin:16px 14px 0;font-size:10px;color:var(--muted);line-height:1.6}@media(max-width:700px){.changes-metrics{grid-template-columns:repeat(2,minmax(0,1fr));margin:0 9px}.changes-toolbar,.changes-timeline,.changes-employee-list,.changes-counts{margin-left:9px;margin-right:9px}.changes-counts{grid-template-columns:repeat(2,minmax(0,1fr))}.changes-coverage{margin-left:9px;margin-right:9px}.changes-section-head{margin-left:9px;margin-right:9px}.changes-event-tag{flex-basis:72px}.changes-event{gap:8px;padding:10px}.changes-metric strong{font-size:15px}.changes-footnote{margin:14px 9px}.page-tab{padding-left:4px;padding-right:4px}.page-tab-main{font-size:10px}.changes-employee-row{align-items:start;flex-direction:column;gap:5px}.changes-employee-row>b{text-align:left}}@media(max-width:380px){.changes-metrics{grid-template-columns:1fr}.page-tab-main{font-size:9px}}' +
'</style>' +
'<style>' +
'/* v2.6 dashboard and section navigation — dark green visual system */' +
'.workspace-tools{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:6px 14px;background:#111a1b;border-bottom:1px solid var(--border)}' +
'.workspace-tools>span{margin-right:4px;color:#9baca4;font-size:11px;font-weight:700}' +
'.workspace-tools button{min-height:34px;padding:7px 12px;border:1px solid #3b514a;border-radius:9px;background:#182823;color:#d8ede3!important;font:750 11px Arial,sans-serif;cursor:pointer}' +
'.workspace-tools button.selected{background:#18432f;border-color:#3eb17e;color:#d6ffe7!important}' +
'.workspace-tools button:hover{background:#254737}' +
'.section-actionbar:not(.wages-actions){grid-template-columns:repeat(2,minmax(0,190px))}' +
'.page-tabs .page-tab{cursor:pointer;min-height:53px}' +
'.page-tab:focus-visible,.workspace-tools button:focus-visible,.dashboard-link:focus-visible,.guide-shortcuts button:focus-visible,.position-person button:focus-visible,.role-opportunity button:focus-visible{outline:3px solid #8debc0;outline-offset:-3px}' +
'.page-tab.active{background:#163c2c;box-shadow:inset 0 -3px 0 #51d99e}' +
'.dashboard-page,.positions-page,.statistics-page{padding-bottom:18px}' +
'.dashboard-hero{align-items:center;padding-top:19px;padding-bottom:10px}' +
'.dashboard-hero h3{font-size:22px;letter-spacing:-.4px}' +
'.dashboard-hero p{font-size:12px;max-width:650px}' +
'.dashboard-quick-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:0 14px 22px}' +
'.dashboard-quick-stats .summary-card{padding:13px;border-color:#344a44;background:#16231e}' +
'.dashboard-quick-stats .summary-card small{font-size:10px;color:#a4c6b3}' +
'.dashboard-quick-stats .summary-card b{font-size:19px;white-space:normal;overflow-wrap:anywhere;line-height:1.3}' +
'.dashboard-quick-stats .summary-card span{font-size:10px;line-height:1.4}' +
'.dashboard-section-title{padding:0 14px 10px}' +
'.dashboard-section-title h4{margin:0 0 4px;font-size:16px;color:#e6f5ed}' +
'.dashboard-section-title p{margin:0;color:#a7b9ae;font-size:11px;line-height:1.5}' +
'.dashboard-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px;padding:0 14px}' +
'.dashboard-link{display:flex;flex-direction:column;align-items:stretch;min-width:0;text-align:left;min-height:206px;padding:16px;cursor:pointer;border-radius:14px;border:1px solid #37584a;background:linear-gradient(165deg,#1c3026,#121b18);color:#e9f5ec!important;transition:border-color .14s,background .14s,transform .14s}' +
'.dashboard-link:nth-child(2){background:linear-gradient(165deg,#1c3032,#141d20);border-color:#365960}' +
'.dashboard-link:nth-child(3){background:linear-gradient(165deg,#243026,#171e1a);border-color:#526044}' +
'.dashboard-link:nth-child(4){background:linear-gradient(165deg,#2a2730,#1c1920);border-color:#594c5e}' +
'.dashboard-link:hover{border-color:#85ddab;transform:translateY(-2px)}' +
'.dashboard-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#a2c5b2;font-size:11px;font-weight:750;letter-spacing:.25px}' +
'.dashboard-card-top>span:last-child{font-size:17px;color:#c3edda}' +
'.dashboard-link>strong{display:block;margin-top:14px;font-size:17px;font-weight:900}' +
'.dashboard-card-number{display:block;margin-top:8px;color:#f4fff7;font-size:23px;line-height:1.25;font-weight:900;overflow-wrap:anywhere;min-height:28px}' +
'.dashboard-card-description{display:block;margin-top:6px;color:#b6c9bc;font-size:12px;line-height:1.5}' +
'.dashboard-card-footer{display:flex;align-items:center;justify-content:space-between;gap:9px;flex-wrap:wrap;margin-top:auto;padding-top:14px;color:#b2cabb;font-size:10px;line-height:1.4}' +
'.dashboard-card-footer b{color:#a8f2cd;white-space:nowrap;font-size:11px}' +
'.dashboard-next{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:14px;padding:14px 16px;border:1px solid #385445;border-radius:12px;background:#14231b}' +
'.dashboard-next b{font-size:13px;color:#ebfaed}' +
'.dashboard-next p{margin:5px 0 0;font-size:11px;line-height:1.5;color:#adc9b8}' +
'.dashboard-next button,.guide-shortcuts button,.settings-route button,.positions-person>button,.positions-section-head button{padding:9px 12px;min-height:36px;flex-shrink:0;border:1px solid #3d9b6a;border-radius:9px;background:#205139;color:#d9f9e6!important;font-weight:800;font-size:11px;cursor:pointer}' +
'.wages-summary .summary{grid-template-columns:repeat(3,minmax(0,1fr))}' +
'.wages-summary .summary-card b{overflow-wrap:anywhere;white-space:normal;font-size:18px}' +
'.positions-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:0 14px 18px}' +
'.positions-metric,.stats-tile{padding:13px;border:1px solid #38504a;border-radius:11px;background:#1a2622;min-width:0}' +
'.positions-metric>* ,.stats-tile>*{display:block}' +
'.positions-metric small,.stats-tile small{font-size:10px;color:#a7c9b6;font-weight:750;line-height:1.5}' +
'.positions-metric strong,.stats-tile strong{display:block;margin-top:6px;color:#effbf3;font-size:19px;line-height:1.35;overflow-wrap:anywhere}' +
'.positions-metric span,.stats-tile span{display:block;margin-top:5px;color:#adbbb2;font-size:10px;line-height:1.45}' +
'.positions-section-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:18px 14px 10px}' +
'.positions-section-head h4{font-size:15px;margin:0 0 4px;color:#e6f6eb}' +
'.positions-section-head p{margin:0;font-size:11px;line-height:1.45;color:#adc0b4}' +
'.positions-employee-list{margin:0 14px 14px;border:1px solid #384d47;border-radius:12px;overflow:hidden;background:#161f1b}' +
'.positions-person{display:grid;grid-template-columns:minmax(110px,1.1fr) minmax(190px,2.2fr) minmax(130px,1fr) auto;gap:10px;align-items:center;padding:12px 14px;border-bottom:1px solid #304139}' +
'.positions-person:last-child{border-bottom:0}' +
'.positions-person-main{min-width:0}' +
'.positions-person-main b{display:block;color:#f0faf3;font-size:12px;overflow-wrap:anywhere}' +
'.positions-person-main small{display:block;color:#98a99e;margin-top:3px;font-size:10px}' +
'.positions-person-roles{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0}' +
'.positions-person-roles>div{min-width:0}' +
'.positions-person-roles small{display:block;font-size:9px;color:#9cac9e;text-transform:uppercase;letter-spacing:.45px}' +
'.positions-person-roles span{display:block;margin-top:3px;font-size:11px;color:#e0f1e4;font-weight:750;overflow-wrap:anywhere}' +
'.positions-person-status{min-width:0}' +
'.positions-person-status>span{font-size:10px;color:#b9dfc4;font-weight:800;display:block}' +
'.positions-person-status small{display:block;color:#9eada5;font-size:9px;margin-top:4px}' +
'.positions-person-status.review>span{color:#f2d7a2}' +
'.positions-person-status.caution>span{color:#ffb9a0}' +
'.positions-planner{margin:0 14px}' +
'.positions-planner .staffing-summary{margin-top:0}' +
'.positions-planner .staffing-table{margin-bottom:10px}' +
'.positions-preferences{margin-top:16px}' +
'.stats-explain{margin:0 14px 12px;padding:12px 14px;border:1px solid #406252;border-radius:11px;background:#14291e}' +
'.stats-explain b{color:#c7f3d8;font-size:12px}' +
'.stats-explain p{color:#bbd2c2;font-size:11px;line-height:1.55;margin:4px 0 0}' +
'.stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:0 14px 8px}' +
'.stats-tile strong{font-size:17px}' +
'.stats-comparison-note{margin:0 14px 10px;padding:10px 13px;border:1px solid #456154;border-radius:9px;background:#17281f;color:#c5dacd;font-size:11px;line-height:1.5}' +
'.stats-deltas{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:0 14px}' +
'.stats-deltas>div{padding:11px;border:1px solid #3c5449;border-radius:10px;background:#18241f;min-width:0}' +
'.stats-deltas small,.stats-deltas strong,.stats-deltas span{display:block;line-height:1.4}' +
'.stats-deltas small{font-size:10px;color:#abc3b5}' +
'.stats-deltas strong{font-size:17px;color:#d6f3df;overflow-wrap:anywhere;margin:5px 0}' +
'.stats-deltas span{font-size:10px;color:#9eafa6}' +
'.stats-footnote{margin:14px;padding:11px 13px;color:#b9c9be;font-size:11px;line-height:1.5}' +
'.settings-route{display:flex;justify-content:space-between;align-items:center;gap:16px}' +
'.settings-route b{font-size:12px;color:#e1f7e9}' +
'.settings-route p{font-size:11px;color:#b9cabe;line-height:1.5;margin:5px 0 0}' +
'.guide-shortcuts{display:flex;flex-wrap:wrap;gap:7px;margin:0 14px 12px}' +
'.guide-shortcuts button{background:#19352a;min-height:36px}' +
'@media(max-width:1000px){.dashboard-quick-stats,.stats-grid,.stats-deltas{grid-template-columns:repeat(2,minmax(0,1fr))}.positions-person{grid-template-columns:minmax(90px,1fr) minmax(160px,2fr) minmax(100px,1fr)}.positions-person>button{grid-column:3;justify-self:start}}' +
'@media(max-width:700px){.workspace-tools{padding:6px 10px;gap:5px}.workspace-tools>span{margin-right:auto;font-size:10px}.workspace-tools button{font-size:10px;padding:6px 10px}.section-actionbar:not(.wages-actions){grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-hero{align-items:flex-start;flex-direction:column;gap:10px}.dashboard-hero h3{font-size:19px}.dashboard-hero p{font-size:11px}.dashboard-quick-stats{margin:0 10px 16px;gap:7px}.dashboard-quick-stats .summary-card b{font-size:16px}.dashboard-section-title{padding:0 10px 9px}.dashboard-links{padding:0 10px;gap:8px}.dashboard-link{padding:12px;min-height:198px}.dashboard-link>strong{font-size:14px;margin-top:12px}.dashboard-card-number{font-size:18px}.dashboard-card-description{font-size:11px}.dashboard-card-footer{flex-direction:column;align-items:flex-start;gap:4px}.dashboard-next{margin:10px;align-items:flex-start;flex-direction:column}.positions-metrics,.stats-grid,.stats-deltas{margin-left:10px;margin-right:10px;gap:7px}.positions-metric,.stats-tile{padding:10px}.positions-metric strong,.stats-tile strong{font-size:15px}.positions-section-head{margin:16px 10px 9px;align-items:flex-start}.positions-section-head h4{font-size:14px}.positions-employee-list{margin-left:10px;margin-right:10px}.positions-person{grid-template-columns:minmax(0,1fr) auto;padding:10px;gap:9px}.positions-person-main{grid-column:1;grid-row:1}.positions-person>button{grid-column:2;grid-row:1;justify-self:end}.positions-person-roles{grid-column:1/-1;grid-row:2}.positions-person-status{grid-column:1/-1;grid-row:3}.positions-planner{margin:0 10px}.stats-explain{margin:0 10px 10px}.stats-comparison-note{margin:0 10px 10px}.stats-footnote{margin:12px 10px}.wages-summary .summary{grid-template-columns:repeat(2,minmax(0,1fr))}.settings-route{align-items:flex-start;flex-direction:column}.guide-shortcuts{margin-left:10px;margin-right:10px}.page-tab{min-height:49px}.page-tab-main{overflow-wrap:anywhere}}' +
'@media(max-width:430px){.dashboard-quick-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-links{grid-template-columns:1fr}.dashboard-link{min-height:158px}.dashboard-card-footer{flex-direction:row;align-items:center}.stats-grid,.stats-deltas{grid-template-columns:repeat(2,minmax(0,1fr))}.positions-metrics{grid-template-columns:1fr 1fr}.positions-metrics .positions-metric:last-child{grid-column:1/-1}.wages-summary .summary{grid-template-columns:1fr 1fr}.wages-summary .summary-card:last-child{grid-column:1/-1}.positions-section-head button{max-width:140px}.page-tabs .page-tab{min-height:48px}.page-tab-main{font-size:10px}}' +
'@media(prefers-reduced-motion:reduce){.dashboard-link{transition:none}.dashboard-link:hover{transform:none}}' +
'</style>' +
'<style>' +
".auto-recording-indicator{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid #293d35;background:#10221a;color:#bdd5c5;font-size:10px;line-height:1.4}.auto-recording-indicator .auto-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:#8b8973}.auto-recording-indicator .auto-dot.enabled{background:#48d695;box-shadow:0 0 0 3px #48d69522}.auto-recording-indicator .auto-dot.paused{background:#c89e65}.auto-recording-indicator>span:nth-child(2){min-width:0;flex:1}.auto-recording-indicator button{border:1px solid #335b45;background:#143c29;color:#c9f4d8!important;border-radius:6px;font-weight:800;font-size:10px;padding:5px 9px;min-height:29px;cursor:pointer}@media(max-width:700px){.auto-recording-indicator{padding:8px 10px}.auto-recording-indicator button{min-height:30px}}" +
'</style>' +
'<div id="overlay"><div id="panel"></div></div>' +
'<div id="keybox"><div class="key-card"><h3>Torn API Key</h3><p data-k="status"></p><input type="password" autocomplete="off" placeholder="Paste Torn API key"><label class="remember"><input type="checkbox" data-k="remember"> Remember on this device (stored in local storage on this device)</label><div class="key-actions"><button data-k="clear">Clear manual key</button><button data-k="cancel">Cancel</button><button data-k="save" class="save">Save key</button></div></div></div>' +
'<div id="toast" role="status" aria-live="polite"></div>';

S.querySelector('#overlay').addEventListener('click', function (e) { if (e.target.id === 'overlay') closePanel(); });
S.querySelector('#keybox [data-k="cancel"]').onclick = function () { S.querySelector('#keybox').classList.remove('show'); if (typeof scheduleLauncherVisibility === 'function') scheduleLauncherVisibility(); };
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
launcher.innerHTML = logoMark('fab-logo');
launcher.style.cssText = [
    'all:initial',
    'position:fixed',
    'right:14px',
    'bottom:100px',
    'width:40px',
    'height:40px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border-radius:13px',
    'border:1px solid #5ccf94',
    'background:linear-gradient(180deg,#123926,#0b2418)',
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

var fabSvg = launcher.querySelector('.fab-logo');
if (fabSvg) {
    fabSvg.style.width = '22px';
    fabSvg.style.height = '22px';
    fabSvg.style.display = 'block';
}
document.documentElement.appendChild(launcher);
try { console.log('[Torn Company Helper] launcher mounted'); } catch (e) {}

var launcherVisibilityTimer = 0;

function ownHelperPopupOpen() {
    return S.querySelector('#overlay').classList.contains('show') || S.querySelector('#keybox').classList.contains('show');
}

function foreignPopupOpen() {
    var dialogs = document.querySelectorAll('[role="dialog"],[aria-modal="true"],.modal,.popup,[class*="modal"],[class*="popup"]');
    for (var i = 0; i < dialogs.length; i++) {
        var el = dialogs[i];
        if (!el || el === launcher || el === host || el.id === ID) continue;
        var style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width >= Math.min(260, innerWidth * 0.45) && r.height >= 120) return true;
    }

    var stack = document.elementsFromPoint(Math.max(1, innerWidth / 2), Math.max(1, innerHeight / 2));
    for (var j = 0; j < stack.length; j++) {
        var node = stack[j];
        if (!node || node === launcher || node === host || node.id === ID || node === document.documentElement || node === document.body) continue;
        var cs = getComputedStyle(node);
        var z = parseInt(cs.zIndex, 10);
        var rect = node.getBoundingClientRect();
        if ((cs.position === 'fixed' || cs.position === 'sticky') && isFinite(z) && z >= 500 &&
            rect.width >= innerWidth * 0.45 && rect.height >= innerHeight * 0.25) return true;
    }
    return false;
}

function refreshLauncherVisibility() {
    var hidden = ownHelperPopupOpen() || foreignPopupOpen();
    launcher.style.setProperty('display', hidden ? 'none' : 'flex', 'important');
}

function scheduleLauncherVisibility() {
    clearTimeout(launcherVisibilityTimer);
    launcherVisibilityTimer = setTimeout(refreshLauncherVisibility, 120);
}

refreshLauncherVisibility();
setInterval(refreshLauncherVisibility, 1200);

dragButton(launcher);
restoreCache();
installAutoCompanyRecording();

// Torn can replace large portions of the company page without a full reload.
// Keep both the panel host and the launcher mounted at the document root.
var launcherSurvivalObserver = new MutationObserver(function () {
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (!launcher.isConnected) document.documentElement.appendChild(launcher);
    scheduleLauncherVisibility();
    observeAutoCompanyRoute();
});
launcherSurvivalObserver.observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['class','style','aria-hidden'] });
window.addEventListener('resize', scheduleLauncherVisibility);
document.addEventListener('visibilitychange', scheduleLauncherVisibility);

}());