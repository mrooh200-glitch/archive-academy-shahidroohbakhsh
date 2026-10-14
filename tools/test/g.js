const {chromium}=require('/opt/node22/lib/node_modules/playwright');
(async()=>{const b=await chromium.launch();
for(const [w,h] of [[1280,800],[390,844]]){const pg=await b.newPage({viewport:{width:w,height:h}});const errs=[];pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto('file://'+process.argv[2]);await pg.waitForTimeout(5000);
await pg.evaluate(()=>scrollTo(0,0));await pg.waitForTimeout(400);
const r=await pg.evaluate(()=>{const ms=[...document.querySelectorAll('mark.flash-highlight')];
const A=document.querySelector('#back-to-top-link');const au=document.querySelector('#tafsir-audio-wrap audio');const ar=au&&au.getBoundingClientRect();
const cells=[...document.querySelectorAll('td.tafsir_ayeh')];
return {marks:ms.map(m=>m.textContent.slice(0,22)),n:ms.length,arrows:document.querySelectorAll('#back-to-top-link').length,arrowInFirst:!!(A&&ms[0]&&A.parentNode.contains(ms[0])),viewer:document.querySelectorAll('input[onclick^=viewer]').length,audio:document.querySelectorAll('audio').length,audioSrc:au&&au.querySelector('source').src,audioRect:ar&&[Math.round(ar.left),Math.round(ar.top),Math.round(ar.width)],ayahNo:[...document.querySelectorAll('.ayah-no')].map(e=>e.textContent),tdSiblings:cells.some(c=>c.previousElementSibling&&c.previousElementSibling.className===c.className),sw:document.documentElement.scrollWidth,iw:innerWidth,menuVis:getComputedStyle(document.querySelector('#menu-main')).visibility,sticky:(document.querySelector('.wrapper-sticky')&&getComputedStyle(document.querySelector('.wrapper-sticky')).display),title:document.querySelector('.post-title').textContent,bodyOY:getComputedStyle(document.body).overflowY,pl:getComputedStyle(document.body).paddingLeft,dlg:document.querySelectorAll('dialog[open]').length,aparat:!!document.querySelector('[id="86443247747"]'),qrTop:null}});
console.log(w,JSON.stringify(r),errs);
await pg.screenshot({path:`/tmp/claude-0/x/b/g${w}.png`});await pg.close()}
await b.close()})();
