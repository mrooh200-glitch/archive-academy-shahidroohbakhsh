import re,json,urllib.parse,html,sys,os
PFX=os.environ.get('PFX','')  # پیشوندِ نامِ فایل: t = متن اصلی، s = مطالعات، خالی = فایل‌هایِ قدیمیِ بدونِ پیشوند
P='/home/user/archive-academy-shahidroohbakhsh/aa/ref/'
U='/root/.claude/uploads/f828941e-4a2f-5bfe-9596-8ce0b171777c/'
R77=open(P+'t22.html',encoding='utf-8').read()
import os
CFG=os.environ['CFG']
if CFG=='123':
    raw=open(U+'9020f96d-123.html',encoding='utf-8').read(); N=123; PDFPAGE=int(os.environ.get('PG','5')); REFKEY='Mishnah Oholot 7:6'
    LIVE='https://www.sefaria.org/Mishnah_Oholot.7.6?lang=bi'
    FS='הָאִשָּׁה שֶׁהִיא מַקְשָׁה לֵילֵד'; FE='חַיֶּיהָ קוֹדְמִין לְחַיָּיו'
    S0='اگر زنی در زایمان مشکل داشته باشد'; S1='زندگی [فرزند] است.'
else:
    raw=open(U+'6ebe65b1-124.html',encoding='utf-8').read(); N=124; PDFPAGE=int(os.environ.get('PG','1')); REFKEY='Mishnah Bava Kamma 5:4'
    LIVE='https://www.sefaria.org/Mishnah_Bava_Kamma.5.4?lang=bi'
    FS='The court appraises the value'; FE='in value to the woman’s husband'
    S0='و مردی که قصد شاخ زدن'; S1='بعد از زایمان چاق خواهد کرد.'
x=raw
def blk(i,src=R77):
    m=re.search(r'<(style|script)[^>]*\bid="%s"[^>]*>.*?</\1>\n?'%i,src,re.S); assert m,i; return m.group(0)
csp=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',R77).group(0)
m=re.search(r'<meta http-equiv=content-security-policy[^>]*>',x); assert m
x=x[:m.start()]+x[m.end():]
assert x.count('<meta charset=utf-8>')>=1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
# disable app scripts (SPA: React bundle would re-render / wipe the static text)
cnt=[0]
def dis(m_):
    t=m_.group(0)
    if 'type=' in t.split('>')[0]: return t
    cnt[0]+=1; return t.replace('<script','<script type="text/plain-disabled-by-archive"',1)
x=re.sub(r'<script(?=[ >])[^>]*>',dis,x)
print('scripts disabled',cnt[0])
# targets
b0=x.index('data-ref="%s"'%REFKEY)
body=re.sub(r'<style.*?</style>|<script.*?</script>','',x[b0:b0+20000],flags=re.S); body=html.unescape(re.sub(r'<[^>]+>','',body))
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
HT=sl(S0,S1); print('TARGET:',HT); T=[HT]
frag=urllib.parse.quote(FS,safe='')+','+urllib.parse.quote(FE,safe='')
art='''<style id="article-indent-style">
  .textRange .segment .translation, .textRange .segment .translation font { font-family: Vazirmatn, Tahoma, Arial, sans-serif !important; font-size: 16px !important; font-weight: 500 !important; line-height: 1.9 !important; }
</style>
'''
extra=open('tools/build/sefaria_wide.css').read() if len(sys.argv)>2 else ''
wide='<style id="wide-layout-fix">\n'+extra+'\n</style>\n'
fonts=''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*fonts[^>]*>',R77))
RAIL='<style id="rail-safe-zone">@media (min-width:860px){body{padding-left:80px !important;padding-right:80px !important;box-sizing:border-box !important;}}</style>\n'
head=fonts+'\n'+blk('brand-style')+blk('chrome-lock')+blk('dark-toggle-lock')+art+blk('heading-style')+wide+RAIL
assert x.count('</head>')==1
x=x.replace('</head>',head+'</head>',1)
ci=R77.index('<div class="side-rail right">'); ce=R77.index('<div id=',ci) if False else None
# banner end: find end of ref-source-banner block
bi=R77.index('<div class="ref-source-banner">'); be=R77.index('</div></span></div>',bi)+len('</div></span></div>')
chrome=R77[ci:be]+'\n'
chrome,k=re.subn(r'<a href="https://hadith\.inoor\.ir[^"]*#:~:text=[^"]*"','<a href="'+LIVE+'#:~:text='+frag+'"',chrome,count=1); assert k==1,k
chrome,k=re.subn(r'\.\./ref-pdf/[ts]?\d+\.pdf#page=\d+','../ref-pdf/%s%d.pdf#page=%d'%(PFX,N,PDFPAGE),chrome,count=1); assert k==1
m=re.search(r'<body[^>]*>',x); x=x[:m.end()]+chrome+x[m.end():]
k=R77.index('<div class="cdk-live-announcer-element'); e=R77.index('\n',k); tail=R77[e+1:]
tail,kk=re.subn(r'var TARGETS = \[.*?\];',lambda m_:'var TARGETS = '+json.dumps(T)+';',tail,count=1,flags=re.S); assert kk==1
tail,kk=re.subn(r'var BOXES = [^;]*;','var BOXES = [null];',tail,count=1); assert kk==1
tail=tail.replace('var SKIP_ARROW = true;','var SKIP_ARROW = false;')
x=x+'\n'+tail
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x))
