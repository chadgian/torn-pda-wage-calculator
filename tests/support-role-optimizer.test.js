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
    const config = {
        protectSupportRoles: options.protectSupportRoles !== false,
        positionAdvice: options.positionAdvice !== false,
        exploreNewRoles: options.exploreNewRoles !== false
    };
    const storage = new Map();
    if (options.staffingPlans) storage.set('staffingPlans', structuredClone(options.staffingPlans));
    const get = (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback;
    const put = (key, value) => storage.set(key, structuredClone(value));
    const src = [
        'var positions=ctx.positions,staff=ctx.staff,cfg=ctx.config;',
        'var company=ctx.company,get=ctx.get,put=ctx.put,fmt=ctx.fmt,money=ctx.money;',
        'var num=function(v){return Number(v)||0;};',
        'var currentPosition=function(e){return positions.find(function(p){return p.id===e.positionId;})||null;};',
        'var positionFit=function(e,p){return p ? (e.fits[p.id]||0):0;};',
        'var individualBestPosition=function(e){return positions.map(function(p){return {position:p,fit:positionFit(e,p)};}).sort(function(a,b){return b.fit-a.fit;})[0]||null;};',
        moduleCode,
        'return { companyPositionAssignment, supportRoleKind, supportRoleSnapshot, staffingPlanInfo,',
        ' potentialRoleBenefit, suggestAdditionalRoles, useAdditionalRolePlan };'
    ].join('\n');
    return new Function('ctx', src)({
        positions, staff, config, get, put,
        company: {
            id: 'company-1', typeId: 'shop',
            capacity: options.capacity ?? staff.length,
            employeeCount: staff.length,
            advertisementBudget: options.advertisementBudget ?? null,
            environment: options.environment ?? null
        },
        fmt: (value) => String(Math.round(Number(value))),
        money: (value) => String(Math.round(Number(value)))
    });
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

test('catalog ability is authoritative even when the job title is unrelated', () => {
    const consultant=position('x','Consultant','Helps with advanced operations.');
    consultant.ability='Trainer';
    const h=harness([consultant],[]);
    assert.equal(h.supportRoleKind(consultant),'trainer');
    const generalManager=position('x2','Marketing Manager','Oversees a sales team.');
    generalManager.ability='None'; // falls back to catalog descriptions / title.
    assert.equal(h.supportRoleKind(generalManager),'marketer');
    const otherSpecial=position('x3','Store Manager','Operates store terminals.');
    otherSpecial.ability='Other';
    assert.equal(h.supportRoleKind(otherSpecial),'');
});

test('proposes unstaffed Trainer while protecting the current Manager', () => {
    const manager=position('m','Manager','Oversees employees.');
    manager.ability='Manager';
    const cashier=position('c','Cashier','Sells items.');
    cashier.ability='None';
    const trainer=position('t','Consultant','Runs staff development.');
    trainer.ability='Trainer';
    const employees=[
        employee('1','Experienced manager',manager,{m:70,c:120,t:115}),
        employee('2','Cashier A',cashier,{m:60,c:90,t:50}),
        employee('3','Cashier B',cashier,{m:100,c:85,t:140})
    ];
    const h=harness([manager,cashier,trainer],employees);
    const ideas=h.suggestAdditionalRoles();
    const offer=ideas.find((x)=>x.key==='t');
    assert.ok(offer,'New Trainer position was considered despite being unstaffed');
    assert.equal(offer.kind,'trainer');
    assert.ok(offer.plan,'Existing cashier role could be repurposed');
    assert.equal(offer.plan.replacesKey,'c');
    assert.equal(offer.plan.targets.m,1);
    assert.equal(offer.plan.targets.c,1);
    assert.equal(offer.plan.targets.t,1);
    const after=h.companyPositionAssignment(offer.plan.targets);
    assert.equal(after.byEmployee['1'].position.id,'m','Original Manager remains Manager');
    assert.equal(after.protectedCount,1);
    assert.equal(offer.openCapacity,0);
});

test('can save an exploratory reallocation only in helper planning targets', () => {
    const cashier=position('c','Cashier','Sells items.');
    const cleaner=position('clean','Cleaner','Improves environment.');
    cleaner.ability='Cleaner';
    const employees=[
        employee('1','A',cashier,{c:80,clean:110}),
        employee('2','B',cashier,{c:75,clean:100})
    ];
    const h=harness([cashier,cleaner],employees,{environment:75});
    const offers=h.suggestAdditionalRoles();
    const offer=offers.find(x=>x.key==='clean');
    assert.ok(offer && offer.plan);
    assert.equal(offer.plan.targets.clean,1);
    assert.equal(h.useAdditionalRolePlan('does-not-exist'),false);
    assert.equal(h.useAdditionalRolePlan('clean'),true);
    const plan=h.staffingPlanInfo();
    assert.equal(plan.custom,true);
    assert.equal(plan.valid,true);
    assert.equal(plan.effective.clean,1);
    assert.equal(plan.effective.c,1);
});

test('identifies spare hiring capacity without fabricating candidate stats', () => {
    const manager=position('m','Manager','Reduces ineffective staff impact.');
    manager.ability='Manager';
    const trainer=position('t','Consultant','Employee training.');
    trainer.ability='Trainer';
    const employees=[employee('1','Manager',manager,{m:90,t:110})];
    const h=harness([manager,trainer],employees,{capacity:2});
    const idea=h.suggestAdditionalRoles().find(x=>x.key==='t');
    assert.ok(idea);
    assert.equal(idea.openCapacity,1);
    assert.equal(idea.plan,null,'Never invent a feasible reallocation by removing the sole Manager');
    assert.equal(h.useAdditionalRolePlan('t'),false,'Cannot save hiring as if already staffed');
});

test('does not remove active support roles or suggest unsupported catalog positions', () => {
    const manager=position('m','Manager','Manages others.');
    manager.ability='Manager';
    const cashier=position('c','Cashier','Sells.');
    const alternateManager=position('m2','Chief Investigator','Leads investigations.');
    alternateManager.ability='Manager';
    const employeeList=[
        employee('1','Manager A',manager,{m:80,c:120,m2:140}),
        employee('2','Cashier A',cashier,{m:100,c:100,m2:130})
    ];
    const h=harness([manager,cashier,alternateManager],employeeList);
    const ideas=h.suggestAdditionalRoles();
    assert.equal(ideas.some(x=>x.key==='m2'),false,'Do not duplicate existing special ability');
});

test('leaves inactive or invalid staffing plan scenarios unavailable', () => {
    const cashier=position('c','Cashier','Sales.');
    const trainer=position('t','Trainer','Trains staff.');
    trainer.ability='Trainer';
    const employees=[employee('1','Cashier',cashier,{c:50,t:90})];
    const hidden=harness([cashier,trainer],employees,{exploreNewRoles:false});
    assert.equal(hidden.suggestAdditionalRoles().length,0);
    const invalid=harness([cashier,trainer],employees,{staffingPlans:{'company-1':{c:3,t:0}}});
    assert.equal(invalid.suggestAdditionalRoles().length,0);
});

test('modeled fit benefits alone gate nonsupport recommendations', () => {
    const cashier=position('c','Cashier','Direct sales.');
    const clerk=position('other','Clerk','Direct sales.');
    const employees=[employee('1','Cashier',cashier,{c:90,other:30})];
    assert.equal(harness([cashier,clerk],employees).suggestAdditionalRoles().length,0);
    const upgraded=[employee('1','Cashier',cashier,{c:30,other:100})];
    const proposal=harness([cashier,clerk],upgraded).suggestAdditionalRoles();
    assert.equal(proposal[0].key,'other');
    assert.equal(proposal[0].plan.fitDelta,70);
});
