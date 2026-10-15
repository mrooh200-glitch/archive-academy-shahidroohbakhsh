import re,json,urllib.parse,html,sys,os
# sacred-texts.com (متن انگلیسی، ترجمه‌شده با گوگل؛ برنامه‌ی Svelte) -> aa/p/N.html. قالب: 77 (+ استایل جعبه‌ی متن اصلی از 56)
# اجرا: python3 -I tools/build/muse.py <خروجی.html> [wide]   با RAW=<فایل خام> PG=<صفحه‌ی PDF>
P='/home/user/archive-academy-shahidroohbakhsh/aa/p/'
R77=open(P+'77.html',encoding='utf-8').read()
R56=open(P+'56.html',encoding='utf-8').read()
raw=open(os.environ['RAW'],encoding='utf-8').read()
N=120; PDFPAGE=int(os.environ.get('PG','21'))
LIVE='https://sacred-texts.com/hin/manu/manu09.htm'
# (شروع و پایان فارسی، متن اصلی انگلیسی، صفحه‌ی PDF)
SPEC=[
 ('۱۳۸. از آنجا که پسری پدرش را از جهنمی','رهایی‌دهنده از پوت) نامید.',
  '138. Because a son delivers (trayate) his father from the hell called Put, he was therefore called put-tra (a deliverer from Put) by the Self-existent (Svayambhu) himself.',21),
]
x=raw
def blk(i,src=R77):
    m=re.search(r'<(style|script)[^>]*\bid="%s"[^>]*>.*?</\1>\n?'%i,src,re.S); assert m,i; return m.group(0)
csp=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',R77).group(0)
m=re.search(r'<meta http-equiv=content-security-policy[^>]*>',x); assert m
x=x[:m.start()]+x[m.end():]
assert x.count('<meta charset=utf-8>')>=1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
cnt=[0]
def dis(m_):
    t=m_.group(0)
    if 'type=' in t.split('>')[0]: return t
    cnt[0]+=1; return t.replace('<script','<script type="text/plain-disabled-by-archive"',1)
x=re.sub(r'<script(?=[ >])[^>]*>',dis,x)
print('scripts disabled',cnt[0])
# متن هایلایت‌ها
b0=x.index('۱۳۷. او از طریق یک پسر')
body=re.sub(r'<style.*?</style>|<script.*?</script>','',x[b0:],flags=re.S); body=html.unescape(re.sub(r'<[^>]+>','',body))
def norm(c):
    o=ord(c)
    if o in (0x200c,0x200d,0x200e,0x200f,0x640) or 0x64b<=o<=0x65f or o==0x670: return ''
    if c in 'يى': return 'ی'
    if c=='ك': return 'ک'
    if c.isspace() or o==0xa0: return ' '
    return c
ns=[];mp=[];last=True
for i,c in enumerate(body):
    q=norm(c)
    if q=='': continue
    if q==' ':
        if last: continue
        last=True
    else: last=False
    ns.append(q);mp.append(i)
NS=''.join(ns)
def sl(a,b):
    A=''.join(norm(c) for c in a); B=''.join(norm(c) for c in b)
    assert NS.count(A)==1,(a,NS.count(A)); s=NS.find(A); e=NS.find(B,s); assert e>=0; e+=len(B)
    return re.sub(r'\s+',' ',body[mp[s]:mp[e-1]+1]).strip()
T=[sl(a,b) for a,b,_,_ in SPEC]
for t in T: print('TARGET:',t)
BOXES=[["متنِ اصلیِ انگلیسی (صفحه‌ی ۲۱ فایل PDF):","ltr",en] for _,_,en,pg in SPEC]
# فرگمنت زنده: هایلایت اول (اولین در ترتیب ظهور)، ۴ واژه‌ی اول و آخر از متن انگلیسی
ew=SPEC[0][2].rstrip('.').split()
frag=urllib.parse.quote(' '.join(ew[:4]),safe='')+','+urllib.parse.quote(' '.join(ew[-4:]),safe='')
art='''<style id="article-indent-style">
  .reader-article-container p:not(.fa-original-en) { text-indent: 0.4cm !important; font-family: Vazirmatn, Tahoma, Arial, sans-serif !important; font-size: 16px !important; font-weight: 500 !important; line-height: 1.9 !important; text-align: right !important; }
  .reader-article-container p:not(.fa-original-en) font { font-family: inherit !important; font-size: inherit !important; font-weight: inherit !important; }
</style>
'''
extra=open('tools/build/sacred_wide.css').read() if len(sys.argv)>2 else ''
wide='<style id="wide-layout-fix">\n'+extra+'\n</style>\n'
fonts=''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*fonts[^>]*>',R77))
RAIL='<style id="rail-safe-zone">@media (min-width:860px){body{padding-left:80px !important;padding-right:80px !important;box-sizing:border-box !important;}}</style>\n'
bs=blk('brand-style'); enc=re.search(r'  \.fa-original-en \{.*?  \.fa-original-en-text \{ display: block; \}\n',R56,re.S).group(0)
assert 'fa-original-en' not in bs and bs.count('            mark.flash-highlight {')==1
bs=bs.replace('            mark.flash-highlight {',enc+'  mark.flash-highlight {')
head=fonts+'\n'+bs+blk('chrome-lock')+blk('dark-toggle-lock')+art+blk('heading-style')+wide+RAIL
assert x.count('</head>')==1
x=x.replace('</head>',head+'</head>',1)
ci=R77.index('<div class="side-rail right">')
bi=R77.index('<div class="ref-source-banner">'); be=R77.index('</div></span></div>',bi)+len('</div></span></div>')
chrome=R77[ci:be]+'\n'
chrome,k=re.subn(r'<a href="https://hadith\.inoor\.ir[^"]*#:~:text=[^"]*"','<a href="'+LIVE+'#:~:text='+frag+'"',chrome,count=1); assert k==1,k
chrome,k=re.subn(r'این صفحه، آرشیوِ یک منبعِ وب است\.','این صفحه، آرشیوِ ترجمه‌شده‌ی یک منبعِ وب است.',chrome,count=1); assert k==1
chrome,k=re.subn(r'\.\./pdf/\d+\.pdf#page=\d+','../pdf/%d.pdf#page=%d'%(N,PDFPAGE),chrome,count=1); assert k==1
m=re.search(r'<body[^>]*>',x); x=x[:m.end()]+chrome+x[m.end():]
k=R77.index('<script id="kill-dialog-script"'); tail=R77[k:]
tail,kk=re.subn(r'var TARGETS = \[.*?\];',lambda m_:'var TARGETS = '+json.dumps(T,ensure_ascii=False)+';',tail,count=1,flags=re.S); assert kk==1
tail,kk=re.subn(r'var BOXES = [^;]*;',lambda m_:'var BOXES = '+json.dumps(BOXES,ensure_ascii=False)+';',tail,count=1); assert kk==1
tail=tail.replace('var SKIP_ARROW = true;','var SKIP_ARROW = false;')
x=x+'\n'+tail
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x))
