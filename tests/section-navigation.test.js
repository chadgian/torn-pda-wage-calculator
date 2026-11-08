'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.resolve(__dirname, '../torn-company-helper.user.js'), 'utf8');
function slice(a,b) {
    const x=script.indexOf(a),y=script.indexOf(b,x);
    assert.ok(x>=0 && y>x,'Missing section: '+a);
    return script.slice(x,y);
}
const sample={id:'1',name:'Sample Employee',position:'Cashier',director:false,
    effectiveness:{total:90},currentFit:70,predictedCurrentFit:60,bestFit:95,
    bestPosition:{name:'Supervisor'},recommendPosition:true,
    wage:900,suggested:1000,change:100,changePct:11,score:1,
    supportProtected:false,supportRisk:''};
const result={rows:[sample],included:1,excluded:0,currentIncluded:900,suggestedIncluded:1000,
    currentAll:900,avgEffectiveness:90,protectedCount:0,positionPlan:{},supportRisks:[]};
const company={name:'Example Corp',rating:4,capacity:2,dailyIncome:10000,
    weeklyIncome:50000,dailyCustomers:20,weeklyCustomers:90,
    efficiency:80,popularity:70,environment:65,funds:30000,
    trains:4,advertisementBudget:1200,value:200000};

function rendered(page) {
    const panel={innerHTML:''};
    const boot=[
        'var S={querySelector:function(){return ctx.panel;}};',
        'var ui={page:ctx.page},company=ctx.company,staff=[{}],positions=[];',
        'var errorState=null,busy=false,lastLoadedAt=Date.now(),FRESH_AGE=900000;',
        'var VERSION="2.6.0",detailId="",cfg={},keySource=function(){return "Demo";};',
        'var nowText=function(){return "recently";},esc=function(x){return String(x);};',
        'var fmt=function(x){return String(x);},logoMark=function(){return "";};',
        'var calculate=function(){return ctx.result;},displayRows=function(x){return x.rows;};',
        'var apiKey=function(){return "demo";},autoSyncStatusText=function(){return "Auto-recording on";};',
        'var pageTab=function(key,label){return \'<button data-page="\'+key+\'">\'+label+\'</button>\';};',
        'var changesPage=function(){return \'<section id="changes-content"></section>\';};',
        'var settingsPage=function(){return \'<section id="settings-content"></section>\';};',
        'var calculationGuidePage=function(){return \'<section id="guide-content"></section>\';};',
        'var wagesPage=function(){return \'<section id="wages-content"></section>\';};',
        'var positionsPage=function(){return \'<section id="positions-content"></section>\';};',
        'var statisticsPage=function(){return \'<section id="statistics-content"></section>\';};',
        'var dashboardPage=function(){return \'<section id="dashboard-content"></section>\';};',
        'var bind=function(){ctx.bound=true;};'
    ].join('\n');
    const ctx={panel,page,company,result,bound:false};
    new Function('ctx',boot+'\n'+slice('function render() {','\nfunction changesPage()')+'\nrender();')(ctx);
    assert.equal(ctx.bound,true);
    return panel.innerHTML;
}

test('v2.6.0 userscript syntax',()=>{
    assert.doesNotThrow(()=>new Function(script));
    assert.match(script,/\/\/ @version\s+2\.6\.0/);
});
test('Dashboard, Wages, Positions, Statistics and Changes are separate top destinations',()=>{
    const html=rendered('dashboard');
    const main=html.match(/<nav class="page-tabs"[^>]*>(.*?)<\/nav>/s)[1];
    for(const name of ['dashboard','wages','positions','statistics','changes']){
        assert.match(main,new RegExp('data-page="'+name+'"'));
    }
    assert.match(html,/data-page="settings"/);
    assert.match(html,/data-page="guide"/);
    assert.match(html,/id="dashboard-content"/);
});
test('tab selection renders only its own screen and wage export actions',()=>{
    for(const page of ['dashboard','wages','positions','statistics','changes','settings','guide']){
        const html=rendered(page);
        assert.match(html,new RegExp('id="'+page+'-content"'));
        for(const other of ['dashboard','wages','positions','statistics','changes','settings','guide']){
            if(other!==page)assert.doesNotMatch(html,new RegExp('id="'+other+'-content"'));
        }
        if(page==='wages'){
            assert.match(html,/data-a="copy"/);
            assert.match(html,/data-a="csv"/);
        }else{
            assert.doesNotMatch(html,/data-a="copy"/);
            assert.doesNotMatch(html,/data-a="csv"/);
        }
    }
});
function sectionPages() {
    const code=slice('function wagesPage(result, visibleRows) {','\nfunction employeesPage(')+
        '\n'+slice('function dashboardLink(', '\nfunction insightCard(');
    const boot=[
        'var company=ctx.company,staff=ctx.staff,positions=ctx.positions,ui={page:"dashboard"};',
        'var cfg={positionAdvice:true,protectSupportRoles:true,exploreNewRoles:true};',
        'var num=function(x){return Number(x)||0;},esc=function(x){return String(x);};',
        'var fmt=function(x){return String(x);},money=function(x){return "$"+String(x);};',
        'var changeReport=function(){return null;},changePeriodDays=function(){return 7;};',
        'var metricText=function(x){return String(x);},suggestAdditionalRoles=function(){return [];};',
        'var summaryCard=function(a,b){return "<div>"+a+" : "+b+"</div>";};',
        'var employeesPage=function(){return \'<section id="wage-rows"></section>\';};',
        'var supportImpactHtml=function(){return \'<section id="support"></section>\';};',
        'var additionalRolesHtml=function(){return \'<section id="additional-roles"></section>\';};',
        'var staffingPlanEditor=function(){return \'<section id="staffing-plan"></section>\';};',
        'var toggle=function(k){return "<label>"+k+"</label>";};'
    ].join('\n');
    return new Function('ctx',boot+'\n'+code+
        '\nreturn {wagesPage,positionsPage,statisticsPage,dashboardPage};')({
            company,staff:[sample],positions:[{id:'1',name:'Cashier'}]
        });
}
test('Wages is a focused payroll review',()=>{
    const h=sectionPages().wagesPage(result,[sample]);
    assert.match(h,/Current daily payroll/);
    assert.match(h,/Suggested daily payroll/);
    assert.match(h,/id="wage-rows"/);
    assert.doesNotMatch(h,/id="staffing-plan"/);
});
test('Positions has assignment advice, support protection and role targets',()=>{
    const h=sectionPages().positionsPage(result);
    for(const part of ['Employee assignments','Sample Employee','id="support"',
        'id="additional-roles"','id="staffing-plan"','protectSupportRoles']){
        assert.ok(h.includes(part),part+' should appear');
    }
    assert.doesNotMatch(h,/Current daily payroll/);
});
test('Statistics shows financial, workforce and health indicators',()=>{
    const h=sectionPages().statisticsPage(result);
    for(const part of ['Company Statistics','not net profit','Daily income',
        'Weekly customers','Company funds','Environment','historical changes']){
        assert.ok(h.includes(part),part+' should appear');
    }
    assert.doesNotMatch(h,/id="staffing-plan"/);
});
test('Dashboard links to all major screens with short summaries only',()=>{
    const h=sectionPages().dashboardPage(result);
    assert.match(h,/at a glance/);
    for(const page of ['wages','positions','statistics','changes'])
        assert.match(h,new RegExp('data-page="'+page+'"'));
    assert.doesNotMatch(h,/id="staffing-plan"/);
    assert.doesNotMatch(h,/id="wage-rows"/);
});
test('How it works covers page navigation; settings no longer duplicates staffing',()=>{
    const code=slice('function settingsPage() {','\nfunction calculationGuidePage()');
    const setup=[
        'var cfg={director:true,fill:false,autoRefresh:true};',
        'var settingField=function(k){return k;},toggle=function(k){return k;};'
    ].join('\n');
    const h=new Function(setup+'\n'+code+'\nreturn settingsPage();')();
    assert.match(h,/Open Positions/);
    assert.doesNotMatch(h,/staffingPlanEditor/);
    assert.doesNotMatch(h,/protectSupportRoles/);
    assert.match(script,/guideCard\('16', 'Finding your way around'/);
});
