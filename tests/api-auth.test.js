'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'torn-company-helper.user.js'),'utf8');

function getApiHarness(bridges) {
    const start=script.indexOf('// Prefer the Torn PDA bridge');
    const end=script.indexOf('\nfunction normalizeEmployees(payload)',start);
    assert.ok(start>=0 && end>start,'API helpers must be present');
    const bootstrap=[
        'var API_BASE="https://api.torn.com/v2",API_COMMENT="TCH test";',
        'var lastApiTransport="Not tested";',
        'var apiKey=function(){return "current-key";};',
        'var num=function(x){return Number(x)||0;};',
        'var apiError=function(m,meta){var e=new Error(m);Object.assign(e,meta||{});return e;};',
        'var PDA_httpGet=ctx.pda;',
        'var GM_xmlhttpRequest=ctx.gm;',
        'var fetch=ctx.fetch;',
        'var normalizeCompany=function(v){return v.profile||v;};',
        'var normalizeEmployees=function(v){return (v.employees||[]).map(function(e){return {wage:e.wage==null?null:e.wage};});}'
    ].join('\n');
    return new Function('ctx',bootstrap+'\n'+script.slice(start,end)+
        '\nreturn {api:api,validateKeyCandidate:validateKeyCandidate,transport:function(){return lastApiTransport;}};')(bridges||{});
}
const ok=(payload,status=200)=>({status,responseText:JSON.stringify(payload)});
test('version, scoped Torn custom-key creation and whitelisted API domain',()=>{
    assert.match(script, /\/\/ @version\s+2\.6\.1/);
    assert.match(script, /\/\/ @connect\s+api\.torn\.com/);
    const link=script.match(/var API_KEY_CREATE_URL = '([^']+)'/)[1];
    assert.ok(link.startsWith('https://www.torn.com/preferences.php#tab=api?step=addNewKey'));
    assert.match(link,/company=employees,profile,news/);
    assert.match(link,/torn=companies/);
    assert.doesNotMatch(link,/user=|faction=|market=/);
    assert.match(script,/>Create API Key<\/a>/);
    assert.match(script,/>Test Connection<\/button>/);
});
test('Torn PDA bridge is preferred over GM XHR and browser fetch',async()=>{
    let nativeCalls=0;
    const h=getApiHarness({
        pda:async(url,headers)=>{nativeCalls++;assert.match(headers.Authorization,/ApiKey current-key/);return ok({profile:{id:45}});},
        gm:()=>{throw Error('Unexpected GM');},
        fetch:()=>{throw Error('Unexpected fetch');}
    });
    assert.deepEqual(await h.api('/company/profile'),{profile:{id:45}});
    assert.equal(nativeCalls,1);
    assert.equal(h.transport(),'Torn PDA');
});
test('userscript manager fallback sends key only in authorization header',async()=>{
    const h=getApiHarness({gm:function(req){
        assert.ok(!req.url.includes('current-key'));
        assert.equal(req.headers.Authorization,'ApiKey current-key');
        req.onload(ok({employees:[]}));
    }});
    assert.deepEqual(await h.api('/company/employees'),{employees:[]});
    assert.equal(h.transport(),'Userscript manager');
});
test('browser fetch is a final fallback with no query-string key',async()=>{
    const h=getApiHarness({fetch:async(url,opt)=>{
        assert.ok(!url.includes('current-key'));
        assert.equal(opt.headers.Authorization,'ApiKey current-key');
        return {ok:true,status:200,json:async()=>({profile:{id:7}})};
    }});
    assert.deepEqual(await h.api('/company/profile'),{profile:{id:7}});
    assert.equal(h.transport(),'Browser fetch');
});
test('API errors preserve Torn codes without retrying another transport',async()=>{
    let calls=0;
    const h=getApiHarness({pda:async()=>{calls++;return ok({error:{code:16,error:'Access denied'}},403);}});
    await assert.rejects(h.api('/company/employees'),e=>e.code===16&&e.status===403);
    assert.equal(calls,1);
});
test('key check probes required endpoints and reports missing wages',async()=>{
    const called=[];
    const h=getApiHarness({pda:async(url,headers)=>{
        called.push(url.split('?')[0]);
        assert.equal(headers.Authorization,'ApiKey candidate-key');
        if(url.includes('/key/info')) return ok({info:{access:{level:3}}});
        if(url.includes('/company/profile')) return ok({profile:{id:100}});
        if(url.includes('/company/employees')) return ok({employees:[{wage:1000},{wage:null}]});
        throw Error('Unknown endpoint');
    }});
    const result=await h.validateKeyCandidate('candidate-key');
    assert.equal(result.count,2);
    assert.equal(result.missing,1);
    assert.deepEqual(called,[
        'https://api.torn.com/v2/key/info',
        'https://api.torn.com/v2/company/profile',
        'https://api.torn.com/v2/company/employees'
    ]);
});
test('missing wages are excluded from salary advice rather than blocking the dashboard',()=>{
    assert.match(script,/return x\.wage != null && excluded\.indexOf/);
    assert.match(script,/Missing wage fields do not prevent the dashboard/);
    assert.doesNotMatch(script,/if \(missingWages\) throw apiError/);
});
