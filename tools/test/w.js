const {chromium}=require('/opt/node22/lib/node_modules/playwright');
(async()=>{const b=await chromium.launch();const res=[];
for(const w of [320,390,600,700,860,900,1000,1100,1159,1160,1200,1280]){const pg=await b.newPage({viewport:{width:w,height:800}});await pg.goto('file://'+process.argv[2]);await pg.waitForTimeout(2500);
res.push(w+':'+await pg.evaluate(()=>document.documentElement.scrollWidth-innerWidth));await pg.close()}
console.log(res.join(' '));
const pg=await b.newPage({viewport:{width:1280,height:900}});await pg.goto('file://'+process.argv[2]);await pg.waitForTimeout(3000);
await pg.click('#darkModeToggle');await pg.waitForTimeout(800);await pg.evaluate(()=>scrollTo(0,0));await pg.waitForTimeout(300);await pg.screenshot({path:'/tmp/claude-0/x/b/dark.png'});
console.log(await pg.evaluate(()=>[...document.querySelectorAll('mark.flash-highlight')].slice(0,1).map(m=>getComputedStyle(m).backgroundColor+' '+getComputedStyle(m).color)));
await b.close()})();
