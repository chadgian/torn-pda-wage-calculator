// ==UserScript==
// @name         Ghost Byte Wage Calculator - Scroll Fix
// @namespace    wyn.torn.company.tools
// @version      1.0.0
// @description  Horizontal touch-drag fix for the Ghost Byte employee wage table only.
// @author       Wyn / OpenAI
// @match        https://www.torn.com/companies.php*
// @match        https://torn.com/companies.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
'use strict';

function findHost(){
  return Array.from(document.querySelectorAll('div[id^="gb-wage-v"]')).find(function(el){return !!el.shadowRoot;}) || null;
}

function bindWrap(wrap){
  if(!wrap || wrap.dataset.gbScrollFixed==='1') return;
  wrap.dataset.gbScrollFixed='1';

  wrap.style.overflowX='scroll';
  wrap.style.webkitOverflowScrolling='touch';
  wrap.style.touchAction='pan-y';
  wrap.style.overscrollBehaviorX='contain';

  var drag=null;

  wrap.addEventListener('touchstart',function(e){
    if(e.touches.length!==1) return;
    var t=e.touches[0];
    drag={x:t.clientX,y:t.clientY,left:wrap.scrollLeft,mode:null};
  },{passive:true});

  wrap.addEventListener('touchmove',function(e){
    if(!drag || e.touches.length!==1) return;
    var t=e.touches[0],dx=t.clientX-drag.x,dy=t.clientY-drag.y;
    if(!drag.mode){
      if(Math.abs(dx)<5 && Math.abs(dy)<5) return;
      drag.mode=Math.abs(dx)>Math.abs(dy)?'x':'y';
    }
    if(drag.mode==='x'){
      e.preventDefault();
      wrap.scrollLeft=drag.left-dx;
    }
  },{passive:false});

  function end(){drag=null;}
  wrap.addEventListener('touchend',end,{passive:true});
  wrap.addEventListener('touchcancel',end,{passive:true});
}

function bind(){
  var host=findHost();
  if(!host) return;
  var wrap=host.shadowRoot.querySelector('.wrap');
  if(wrap) bindWrap(wrap);
}

bind();
var observer=new MutationObserver(bind);
observer.observe(document.documentElement,{childList:true,subtree:true});

}());
