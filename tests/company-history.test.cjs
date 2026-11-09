'use strict';
// Run: node tests/company-history.test.cjs
// Uses actual userscript functions with mocked browser storage; no API calls.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','torn-company-helper.user.js'),'utf8');
new Function(source);
function section(start,end) {
    const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
    assert.ok(a>=0&&b>a,'Missing userscript section: '+start);
    return source.slice(a,b);
}
const functions=
    section('function snapshotPositionCounts(snapshot) {','function currentNamedPositionCounts()')+
    section('function dailyArchiveStorageKey(id) {','async function updateCompanyChanges(c, employees) {')+
    section('function historyDayKey(ts) {','function historicalSnapshotsWithCurrent() {')+
    section('function dailyHistoricalSnapshots(limitDays, includeToday) {','function pctDelta(previous, latest)')+
    section('function pctDelta(previous, latest) {','function snapshotRoleDelta(previous, latest)')+
    section('function snapshotRoleDelta(previous, latest) {','function snapshotRosterDelta(previous, latest)')+
    section('function roleHistoricalEvidence() {','function learnedRoleFloor(position,evidence,recentSignals)');

const setup=[
    "const PFX='gb-wage:',saved={};",
    "const localStorage={setItem(k,v){saved[k]=v;},getItem(k){return saved[k]||null;}};",
    "const get=(k,v)=>{try{return JSON.parse(saved[PFX+k])??v;}catch(e){return v;}};",
    "const num=v=>Number(v)||0,clamp=(v,a,b)=>Math.min(b,Math.max(a,v));",
    "const metricDefinitions=()=>[{key:'dailyIncome'},{key:'dailyCustomers'},{key:'efficiency'},{key:'avgEffectiveness'},{key:'advertisementBudget'},{key:'employeeCount'}];",
    "let company={id:'test'},staff=[{id:'a',position:'Administrator'},{id:'b',position:'Cashier'}],positions=[{name:'Administrator',id:'1'},{name:'Cashier',id:'2'}],lastLoadedAt=Date.parse('2026-11-10T00:20:00Z');",
    "const positionKey=p=>String(p.id||p.name||'');",
    "const positionNameKey=p=>String(p.name||p||'').trim().toLowerCase();",
    "function currentLive(){return {ts:lastLoadedAt,company:{dailyIncome:1000,dailyCustomers:100,efficiency:80,avgEffectiveness:80,advertisementBudget:0,employeeCount:2},staff};}",
    "const historicalSnapshotsWithCurrent=()=>[currentLive()];",
    "function day(d,income,a,c){return {ts:Date.parse(d+'T23:00:00Z'),company:{dailyIncome:income,dailyCustomers:Math.round(income/10),efficiency:80,avgEffectiveness:80,advertisementBudget:0,employeeCount:2},roleCounts:{administrator:a,cashier:c}};}"
].join('\n');

const scenarios=[
    "const old=day('2023-01-01',800,1,1);",
    "const days=[day('2026-11-01',1000,1,1),day('2026-11-02',500,0,2),day('2026-11-03',480,0,2),day('2026-11-04',1100,1,1),day('2026-11-05',1080,1,1),day('2026-11-06',490,0,2),day('2026-11-07',470,0,2),day('2026-11-08',1120,1,1),day('2026-11-09',1140,1,1)];",
    "if(!saveLifetimeDailyHistory('test',[old].concat(days).concat([currentLive()])))throw Error('Storage failed');",
    "const completed=dailyHistoricalSnapshots(0,false),inclusive=dailyHistoricalSnapshots(0,true);",
    "const learned=roleHistoricalEvidence(),coverage=historicalLearningCoverage();",
    "const revised=day('2026-11-09',1190,1,1);revised.ts+=30000;saveLifetimeDailyHistory('test',[revised]);",
    "saveLifetimeDailyHistory('other',[day('2025-01-01',900,0,2)]);",
    "return {count:completed.length,inclusive:inclusive.length,first:completed[0].ts===old.ts,last:historyDayKey(completed[completed.length-1].ts),coverage:coverage.first===old.ts,latest:readLifetimeDailyHistory('test').slice(-2)[0].company.dailyIncome,other:readLifetimeDailyHistory('other').length,admin:learned['1'],cashier:learned['2']};"
].join('\n');
const actual=new Function(setup+'\n'+functions+'\n'+scenarios)();
assert.equal(actual.count,10,'Every observed completed day, including older than 180 days');
assert.equal(actual.inclusive,11,'Current day is stored, but excluded from learning');
assert.equal(actual.first,true);
assert.equal(actual.coverage,true);
assert.equal(actual.last,'2026-11-09');
assert.equal(actual.latest,1190,'Only latest same-day observation retained');
assert.equal(actual.other,1,'Company histories are isolated');
assert.ok(actual.admin.score>0,'Administrator recovery gets positive signal');
assert.ok(actual.cashier.score<0,'Extra Cashier gets caution');
assert.equal(actual.admin.observations,4,'Refreshes must not count as independent days');
assert.equal(actual.admin.confidence,'medium');
console.log('PASS: syntax, lifetime archive, completed-day cutoff, deduplication, isolation, role evidence.');
