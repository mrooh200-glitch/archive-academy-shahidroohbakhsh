const {chromium}=require('/opt/node22/lib/node_modules/playwright');
const files=process.argv.slice(2);
(async()=>{const b=await chromium.launch();
for(const f of files){for(const w of [1000,1280]){const pg=await b.newPage({viewport:{width:w,height:800}});await pg.goto('file://'+f);await pg.waitForTimeout(3000);
const r=await pg.evaluate(async()=>{const rail=document.querySelector('.side-rail.left');const rd=getComputedStyle(rail).display;const H=document.documentElement.scrollHeight;let tot=0,cov=0;const who={};
for(let sy=0;sy<H;sy+=Math.max(400,H/25)){scrollTo(0,sy);await new Promise(r=>setTimeout(r,30));
 for(let y=60;y<innerHeight;y+=40){for(const x of [20,innerWidth-20]){tot++;const els=document.elementsFromPoint(x,y);const i=els.findIndex(e=>e.classList&&e.classList.contains('side-rail'));
  if(i<0){cov++;continue}
  let c=false;for(let k=0;k<i;k++){const e=els[k];if(e===document.documentElement||e===document.body)continue;if(e.closest('.brand-topbar,.ref-source-banner'))continue;const cs=getComputedStyle(e);const bg=cs.backgroundColor;const op=!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)||cs.backgroundImage!=='none';if(op){c=true;who[e.tagName+'.'+(e.className||'').toString().slice(0,25)+'#'+e.id]=(who[e.tagName+'.'+(e.className||'').toString().slice(0,25)+'#'+e.id]||0)+1;break}}
  if(c)cov++}}}
return {display:rd,width:getComputedStyle(rail).width,z:getComputedStyle(rail).zIndex,covered:Math.round(100*cov/tot)+'%',who:Object.entries(who).sort((a,b)=>b[1]-a[1]).slice(0,3)}});
console.log(f.split('/').pop(),w,JSON.stringify(r));await pg.close()}}
await b.close()})();
