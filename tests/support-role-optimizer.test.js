'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.resolve(__dirname, '../torn-company-helper.user.js'), 'utf8');
const start = script.indexOf('var POSITION_STABILITY_BONUS = 2;');
const end = script.indexOf('\nfunction constrainedRaw(', start);
assert.ok(start > -1 && end > start, 'Support-aware position assignment code exists');
const moduleCode = script.slice(start, end);

function position(id, name, description = '') {
    return { id, name, description, required: { manual: 1000, intelligence: 1000, endurance: 1000 } };
}
function employee(id, name, pos, fits, management = 0) {
    return { id, name, position: pos.name, positionId: pos.id, director: false,
        fits, effectiveness: { management, total: 100 } };
}
function harness(positions, staff, options = {}) {
    const config = { protectSupportRoles: options.protectSupportRoles !== false };
    const get = (key, fallback) => key === 'staffingPlans' && options.staffingPlans ?
        options.staffingPlans : fallback;
    const src = [
        'var positions=ctx.positions,staff=ctx.staff,cfg=ctx.config;',
        'var company={id:"company-1", typeId:"shop"},get=ctx.get,put=function(){};',
        'var num=function(v){return Number(v)||0;};',
        'var currentPosition=function(e){return positions.find(function(p){return p.id===e.positionId;})||null;};',
        'var positionFit=function(e,p){return p ? (e.fits[p.id]||0):0;};',
        'var individualBestPosition=function(e){return positions.map(function(p){return {position:p,fit:positionFit(e,p)};}).sort(function(a,b){return b.fit-a.fit;})[0]||null;};',
        moduleCode,
        'return { companyPositionAssignment, supportRoleKind, supportRoleSnapshot, staffingPlanInfo };'
    ].join('\n');
    return new Function('ctx', src)({ positions, staff, config, get });
}

test('complete userscript parses', () => {
    assert.doesNotThrow(() => new Function(script));
});

test('preserves a low-fit Manager even when the Cashier swap looks better by stats alone', () => {
    const manager = position('m','Store Manager','Manager. Improves team effectiveness.');
    const cashier = position('c','Cashier','Serves customers at the register.');
    const staff = [
        employee('1','Incumbent manager',manager,{m:20,c:150},0),
        employee('2','Cashier with low work stats',cashier,{m:140,c:30},12)
    ];
    const protectedPlan = harness([manager,cashier],staff);
    const result = protectedPlan.companyPositionAssignment();
    assert.equal(result.byEmployee['1'].position.id, 'm');
    assert.equal(result.byEmployee['2'].position.id, 'c');
    assert.equal(result.byEmployee['1'].supportProtected, true);
    assert.equal(result.protectedCount, 1);
    assert.equal(result.supportRisks.length, 0);
    assert.equal(result.support.managementTotal, 12);
    assert.equal(result.support.managementRecipients, 1);

    const comparison = harness([manager,cashier],staff,{protectSupportRoles:false}).companyPositionAssignment();
    assert.equal(comparison.byEmployee['1'].position.id,'c');
    assert.equal(comparison.byEmployee['2'].position.id,'m');
    assert.equal(comparison.supportRisks.length,2);
});

test('catalog role-family prefix overrides misleading job title', () => {
    const p = position('mk','Marketing Manager','Marketer. Improves advertising campaigns.');
    const h = harness([p],[]);
    assert.equal(h.supportRoleKind(p),'marketer');
    assert.equal(h.supportRoleKind(position('x','Cashier','Handles registers for the manager.')),'');
    assert.equal(h.supportRoleKind(position('tr','HR Officer','Trainer. Gives more company trains.')),'trainer');
    assert.equal(h.supportRoleKind(position('cl','Cleaner','Cleaner. Improves environment.')),'cleaner');
    assert.equal(h.supportRoleKind(position('s','Bookkeeper','Secretary. Shows employee reports.')),'secretary');
});

test('preserves each existing support occupant when support slots remain', () => {
    const positions = [
        position('m','Manager','Manager. Team bonus.'),
        position('mk','Marketing Manager','Marketer. Boosts ads.'),
        position('t','HR Officer','Trainer. Gives trains.'),
        position('cl','Janitor','Cleaner. Environment.'),
        position('c','Cashier','Customer sales.')
    ];
    const staff = positions.map((p,i) => employee(String(i+1), 'Employee '+i, p,
        Object.fromEntries(positions.map((x,j) => [x.id, i===j ? 20 : 100]))));
    const result = harness(positions,staff).companyPositionAssignment();
    assert.equal(result.protectedCount,4);
    for (let i=0;i<4;i++) {
        assert.equal(result.byEmployee[String(i+1)].position.id,positions[i].id);
        assert.equal(result.byEmployee[String(i+1)].supportProtected,true);
    }
    assert.equal(result.supportRisks.length,0);
});

test('custom staffing that removes a Manager slot is flagged even with protection enabled', () => {
    const manager=position('m','Store Manager','Manager. Improves company effectiveness.');
    const cashier=position('c','Cashier','Sales.');
    const staff=[
        employee('1','Manager',manager,{m:60,c:100}),
        employee('2','Cashier',cashier,{m:40,c:90})
    ];
    const staffingPlans={ 'company-1': {'m':0,'c':2} };
    const result=harness([manager,cashier],staff,{staffingPlans}).companyPositionAssignment();
    assert.equal(result.plan.valid,true);
    assert.equal(result.byEmployee['1'].position.id,'c');
    assert.equal(result.byEmployee['1'].supportProtected,false);
    assert.equal(result.supportRisks.length,1);
    assert.match(result.byEmployee['1'].supportRisk,/unknown/);
});

test('ordinary employee assignments still optimize work-stat fit', () => {
    const sales=position('s','Salesperson','Direct sales.');
    const cashier=position('c','Cashier','Direct sales.');
    const staff=[
        employee('1','First',sales,{s:25,c:120}),
        employee('2','Second',cashier,{s:150,c:20})
    ];
    const result=harness([sales,cashier],staff).companyPositionAssignment();
    assert.equal(result.byEmployee['1'].position.id,'c');
    assert.equal(result.byEmployee['2'].position.id,'s');
    assert.equal(result.protectedCount,0);
    assert.equal(result.supportRisks.length,0);
});

test('unreported management data is not treated as confirmed zero contribution', () => {
    const m=position('m','Manager','Manager. Improves effectiveness.');
    const e=employee('1','Manager',m,{m:100});
    e.effectiveness.management=null;
    const snap=harness([m],[e]).supportRoleSnapshot();
    assert.equal(snap.managementReported,0);
    assert.equal(snap.counts.manager,1);
});
