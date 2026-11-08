'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const script = fs.readFileSync(path.resolve(__dirname, '../torn-company-helper.user.js'), 'utf8');
const start = script.indexOf('/* Company Changes:');
const end = script.indexOf('function displayRows(result)', start);
assert.ok(start > -1 && end > start, 'Company Changes module is present');
const moduleCode = script.slice(start, end);

function makeHarness(newsProvider = async () => ({ news: [] })) {
    const store = new Map();
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const utils = {
        get: (key, fallback) => store.has(key) ? copy(store.get(key)) : fallback,
        put: (key, value) => store.set(key, copy(value)),
        document: {
            // HTML is parsed in an inert template in the actual browser.
            createElement() {
                const node = { content: { textContent: '' } };
                Object.defineProperty(node, 'innerHTML', {
                    set(value) { this.content.textContent = String(value).replace(/<[^>]+>/g, ''); }
                });
                return node;
            }
        },
        api: newsProvider,
        num: (value) => Number(value) || 0,
        sum: (items, selector) => items.reduce((total, item) => total + (Number(selector(item)) || 0), 0),
        avg: (items, selector) => items.length ?
            items.reduce((total, item) => total + (Number(selector(item)) || 0), 0) / items.length : 0,
        money: (value) => (value < 0 ? '-' : '') + '$' + Math.abs(Math.round(value)),
        fmt: (value) => String(Math.round(value))
    };
    const factory = new Function('ctx', [
        'var get=ctx.get, put=ctx.put, document=ctx.document, api=ctx.api;',
        'var num=ctx.num, sum=ctx.sum, avg=ctx.avg, money=ctx.money, fmt=ctx.fmt;',
        'var company=null, staff=[], lastLoadedAt=0, changeRange="7", changesError="";',
        moduleCode,
        'return { newsEventType, reportedFiringReason, updateCompanyChanges, changeReport,',
        ' changeReportText, readChangeHistory, setState(c,s,t,r) { company=c; staff=s;',
        ' lastLoadedAt=t; changeRange=r || "7"; } };'
    ].join('\n'));
    return factory(utils);
}

const t0 = Date.UTC(2026, 10, 8, 1, 0);
const employee = (id, name, effectiveness = 80) => ({
    id: String(id), name, position: 'Cashier', wage: 10000,
    director: false, effectiveness: { total: effectiveness }
});
const company = (id, income, hired = 1) => ({
    id: String(id), name: 'Test Company', dailyIncome: income,
    weeklyIncome: income * 7, employeeCount: hired, rating: 4,
    efficiency: 95, dailyCustomers: 100, weeklyCustomers: 700
});

test('complete userscript is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(script));
});

test('recognizes dismissals and only extracts stated reasons', () => {
    const h = makeHarness();
    assert.equal(h.newsEventType('Ada was fired from the company'), 'fired');
    assert.equal(h.newsEventType('Bert left the company'), 'left');
    assert.equal(h.newsEventType('Carl joined the company'), 'joined');
    assert.equal(h.reportedFiringReason('Ada was fired for repeated inactivity'), 'repeated inactivity');
    assert.equal(h.reportedFiringReason('Ada was fired due to poor performance'), 'poor performance');
    assert.equal(h.reportedFiringReason('Ada was fired'), '');
});

test('first refresh establishes a baseline without fabricated deltas', async () => {
    const h = makeHarness();
    h.setState(company(100, 10000), [employee(1, 'Ada')], t0);
    await h.updateCompanyChanges(company(100, 10000), [employee(1, 'Ada')]);
    const report = h.changeReport();
    assert.equal(report.baseline, null);
    assert.equal(report.partial, true);
    assert.equal(report.metrics.length, 0);
});

test('tracks income and effectiveness and does not duplicate official joins', async () => {
    const h = makeHarness(async () => ({
        news: [
            { id: 'join:2', timestamp: (t0 + 3600000) / 1000, text: 'Bert joined the company' },
            { id: 'fire:3', timestamp: (t0 + 5400000) / 1000, text: 'Carl was fired due to repeated inactivity' }
        ]
    }));
    const first = [employee(1, 'Ada', 70)];
    h.setState(company(100, 10000), first, t0);
    await h.updateCompanyChanges(company(100, 10000), first);
    const next = [employee(1, 'Ada', 90), employee(2, 'Bert')];
    h.setState(company(100, 15000, 2), next, t0 + 2 * 3600000);
    await h.updateCompanyChanges(company(100, 15000, 2), next);
    const report = h.changeReport();
    assert.ok(report.metrics.some((m) => m.key === 'dailyIncome' && m.delta === 5000));
    assert.ok(report.employeeChanges.some((e) => e.name === 'Ada' && e.type === 'Effectiveness'));
    assert.equal(report.events.filter((e) => e.type === 'joined').length, 1);
    assert.ok(report.events.some((e) => e.type === 'fired' && e.reason === 'repeated inactivity'));
    assert.match(h.changeReportText(report), /NOT summed earnings/);
});

test('roster-only departures are explicitly unconfirmed', async () => {
    const h = makeHarness();
    const previous = [employee(1, 'Ada'), employee(2, 'Bert')];
    h.setState(company(100, 10000, 2), previous, t0);
    await h.updateCompanyChanges(company(100, 10000, 2), previous);
    const next = [employee(1, 'Ada')];
    h.setState(company(100, 8000), next, t0 + 7200000);
    await h.updateCompanyChanges(company(100, 8000), next);
    const report = h.changeReport();
    assert.ok(report.events.some((event) => event.type === 'unconfirmed' && event.text.includes('Bert')));
    assert.equal(report.events.filter((event) => event.type === 'fired').length, 0);
});

test('different company IDs do not share history or movements', async () => {
    const h = makeHarness();
    h.setState(company(100, 10000), [employee(1, 'Ada')], t0);
    await h.updateCompanyChanges(company(100, 10000), [employee(1, 'Ada')]);
    h.setState(company(200, 30000), [employee(4, 'Dina')], t0 + 60000);
    await h.updateCompanyChanges(company(200, 30000), [employee(4, 'Dina')]);
    const report = h.changeReport();
    assert.equal(report.metrics.length, 0);
    assert.ok(!report.events.some((event) => event.text.includes('Ada')));
    assert.equal(h.readChangeHistory(100).snapshots.length, 1);
    assert.equal(h.readChangeHistory(200).snapshots.length, 1);
});
