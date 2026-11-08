'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.resolve(__dirname, '../torn-company-helper.user.js'), 'utf8');
function extract(begin, end) {
    const a=script.indexOf(begin), b=script.indexOf(end, a);
    assert.ok(a>=0 && b>a, 'Cannot locate '+begin);
    return script.slice(a,b);
}
const autoCode=extract('function autoSyncIsAllowed() {','async function load() {');
const historyCode=extract('function snapshotFingerprint(snapshot) {','function metricDefinitions() {');

function makeAutoHarness() {
    const state={
        now: 10_000_000, own:true, key:true, hidden:false,
        fail:false, calls:0, renders:0, timers:[], events:{},
        store:new Map()
    };
    const document={
        visibilityState:'visible',
        addEventListener(event,handler){ (state.events['document:'+event] ||= []).push(handler); }
    };
    const window={
        addEventListener(event,handler){ (state.events['window:'+event] ||= []).push(handler); }
    };
    const ctx={
        state,document,window,
        location:{pathname:'/companies.php',search:'?step=your'},
        get(key,fallback){return state.store.has(key) ? structuredClone(state.store.get(key)):fallback;},
        put(key,value){state.store.set(key,structuredClone(value));},
        remove(key){state.store.delete(key);},
        fetchAll:async()=>{state.calls++;if(state.fail)throw new Error('Simulated API failure');},
        setTimeout(handler,delay){
            const timer={handler,delay,cancelled:false};
            state.timers.push(timer);return timer;
        },
        clearTimeout(timer){if(timer)timer.cancelled=true;},
        setInterval(handler,interval){state.interval={handler,interval};},
        now:()=>state.now
    };
    const bootstrap=[
        'var cfg={autoRefresh:true},busy=false,company={id:"101"};',
        'var PFX="gb-wage:",lastLoadedAt=0;',
        'var AUTO_SYNC_INTERVAL=300000,AUTO_SYNC_VISIT_GAP=90000;',
        'var AUTO_SYNC_CHANGE_GAP=45000,AUTO_SYNC_FAILURE_BACKOFF=300000;',
        'var AUTO_SYNC_LEASE_MS=90000,autoSyncTimer=0,autoSyncOwner="tab-A",autoSyncRoute="";',
        'var document=ctx.document,window=ctx.window,location=ctx.location;',
        'var get=ctx.get,put=ctx.put,remove=ctx.remove,fetchAll=ctx.fetchAll;',
        'var setTimeout=ctx.setTimeout,clearTimeout=ctx.clearTimeout,setInterval=ctx.setInterval;',
        'var Date={now:ctx.now},num=function(x){return Number(x)||0;};',
        'var apiKey=function(){return ctx.state.key?"test-key":"";};',
        'var isOwnCompanyView=function(){return ctx.state.own;};',
        'var S={querySelector:function(){return {classList:{contains:function(){return false;}}};},activeElement:null};',
        'var host={contains:function(){return false;}},launcher={contains:function(){return false;}};',
        'var render=function(){ctx.state.renders++;},restoreCache=function(){return true;};',
        'var nowText=function(){return "a moment ago";};'
    ].join('\n');
    const api=new Function('ctx',bootstrap+'\n'+autoCode+'\nreturn {'+
        'runAutoCompanySync,autoSyncIsAllowed,autoSyncStatusText,'+
        'scheduleAutoCompanySync,observeAutoCompanyRoute,'+
        'companyActionElement,installAutoCompanyRecording};')(ctx);
    return {state,ctx,api};
}

test('automatic company refresh runs with panel closed and throttles repeat visits', async()=>{
    const {api,state}=makeAutoHarness();
    assert.equal(await api.runAutoCompanySync('company-visit'),true);
    assert.equal(state.calls,1);
    assert.equal(state.store.get('autoSyncState').lastSuccess,state.now);
    assert.equal(state.store.has('autoSyncLease'),false);
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    assert.equal(state.calls,1);
    state.now+=90_001;
    assert.equal(await api.runAutoCompanySync('company-visit'),true);
    assert.equal(state.calls,2);
});

test('off, no key, hidden tab and non-owned page never poll Torn', async()=>{
    const {api,state,ctx}=makeAutoHarness();
    ctx.document.visibilityState='hidden';
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    ctx.document.visibilityState='visible';state.key=false;
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    state.key=true;state.own=false;
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    assert.equal(state.calls,0);
    assert.match(api.autoSyncStatusText(),/own company/);
});

test('company actions use a shorter cooldown than company visits',async()=>{
    const {api,state}=makeAutoHarness();
    assert.equal(await api.runAutoCompanySync('company-visit'),true);
    state.now+=46_000;
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    assert.equal(await api.runAutoCompanySync('company-action'),true);
    assert.equal(state.calls,2);
});

test('failed automatic calls do not create fake records, and retry after backoff',async()=>{
    const {api,state}=makeAutoHarness();
    state.fail=true;
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    assert.equal(state.store.get('autoSyncState').lastSuccess,0);
    assert.match(api.autoSyncStatusText(),/could not refresh/);
    assert.equal(state.store.has('autoSyncLease'),false);
    state.now+=120_000;state.fail=false;
    assert.equal(await api.runAutoCompanySync('company-action'),false);
    state.now+=180_001;
    assert.equal(await api.runAutoCompanySync('company-visit'),true);
    assert.equal(state.store.get('autoSyncState').lastSuccess,state.now);
    assert.equal(state.calls,2);
});

test('another Torn tab holding the refresh lease prevents duplicate requests',async()=>{
    const {api,state}=makeAutoHarness();
    state.store.set('autoSyncLease',{owner:'tab-B',expires:state.now+60_000});
    assert.equal(await api.runAutoCompanySync('company-visit'),false);
    assert.equal(state.calls,0);
    state.now+=60_001;
    assert.equal(await api.runAutoCompanySync('company-visit'),true);
    assert.equal(state.calls,1);
});

test('company route, action click and submit install debounced auto checks',()=>{
    const {api,state,ctx}=makeAutoHarness();
    api.installAutoCompanyRecording();
    assert.ok(state.timers.some(t=>t.delay===700));
    assert.equal(state.interval.interval,300000);
    const action={
        nodeType:1,disabled:false,textContent:'Update company wages',
        closest(){return this;},getAttribute(){return null;}
    };
    assert.equal(api.companyActionElement(action),action);
    const other={...action,textContent:'Open profile'};
    assert.equal(api.companyActionElement(other),null);
    state.events['document:click'][0]({target:action});
    assert.equal(state.timers.at(-1).delay,4500);
    state.events['document:submit'][0]({target:{nodeType:1}});
    assert.equal(state.timers.at(-1).delay,4500);
    state.events['document:visibilitychange'][0]();
    assert.equal(state.timers.at(-1).delay,800);
    state.own=false;
    state.events['document:click'][0]({target:action});
    assert.equal(state.timers.at(-1).delay,800,'Other company pages are ignored');
    ctx.location.search='?step=other';
    api.observeAutoCompanyRoute();
    assert.equal(state.timers.at(-1).cancelled,true,'Pending sync is cancelled on route exit');
});

test('snapshot compaction keeps recent observations and daily long-range baselines',()=>{
    const fn=new Function('samples','now',historyCode+
        '\nreturn compactCompanySnapshots(samples,now);');
    const now=Date.UTC(2026,10,9,8,0,0);
    const mk=(age,version)=>({ts:now-age,company:{dailyIncome:version},staff:[]});
    const samples=[];
    // Many meaningful recent updates must be retained in order.
    for(let i=0;i<120;i++)samples.push(mk(120*60000-i*60000,i));
    for(let i=1;i<105;i++)samples.push(mk(i*86400000,i+200));
    samples.push(mk(190*86400000,1));
    const result=fn(samples,now);
    assert.ok(result.length>200);
    assert.ok(result.length<=480);
    assert.ok(result.some(x=>x.company.dailyIncome===0));
    assert.ok(result.some(x=>x.company.dailyIncome===119));
    assert.ok(result.some(x=>x.ts<now-90*86400000));
    assert.ok(result.every(x=>x.ts>=now-180*86400000));
    assert.ok(result.every((x,i)=>i===0||x.ts>=result[i-1].ts));
});

test('automatic feature is documented and can be turned off in settings',()=>{
    assert.match(script,/installAutoCompanyRecording\(\);/);
    assert.match(script,/toggle\('autoRefresh', 'Auto-refresh and record company visits/);
    assert.match(script,/guideCard\('17', 'Automatic company refresh and data recording'/);
    assert.match(script,/auto-recording-indicator/);
});
