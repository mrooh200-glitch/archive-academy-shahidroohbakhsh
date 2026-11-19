import re,json,urllib.parse,html,sys,os
PFX=os.environ.get('PFX','')  # پیشوندِ نامِ فایل: t = متن اصلی، s = مطالعات، خالی = فایل‌هایِ قدیمیِ بدونِ پیشوند
P='/home/user/archive-academy-shahidroohbakhsh/aa/ref/'
U='/root/.claude/uploads/f828941e-4a2f-5bfe-9596-8ce0b171777c/'
REF=open(P+'t22.html',encoding='utf-8').read()
raw=open(U+'13da542a-200.html',encoding='utf-8').read()
url=raw.split('\n')[2].split('url:')[1].strip()
N=200; PDFPAGE=1
phrase_s0,phrase_s1='مُلِئَتْ','اَلْحَرَامِ'
x=raw
m=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',REF); csp=m.group(0)
assert x.count('<meta charset=utf-8>')==1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
mk='<style>.sf-hidden{display:none!important}</style>'
a=REF.index(mk)+len(mk); b=REF.index('\n <app-root'); seg=REF[a:b]+'\n'
# page-text targets
body=re.sub(r'<style.*?</style>|<script.*?</script>','',raw[raw.index('<body dir=rtl>'):],flags=re.S); body=html.unescape(re.sub(r'<[^>]+>',' ',body))
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
def sl(s0,s1):
    A=''.join(norm(c) for c in s0); B=''.join(norm(c) for c in s1)
    s=NS.find(A); assert s>=0
    assert NS.count(A+NS[s+len(A):s+len(A)+0])>=1
    e=NS.find(B,s); assert e>=0; e+=len(B); st=mp[s]; en=mp[e-1]+1
    while en<len(body) and (0x64b<=ord(body[en])<=0x65f or ord(body[en])==0x670): en+=1
    return re.sub(r'\s+',' ',body[st:en]).strip()
T=[sl(phrase_s0,phrase_s1)]
print('occurrences of start',NS.count(''.join(norm(c) for c in phrase_s0)),'TARGET:',T)
frag=urllib.parse.quote(T[0],safe='')
seg2,k=re.subn(r'href="https://hadith\.inoor\.ir[^"]*#:~:text=[^"]*"','href="'+url+'#:~:text='+frag+'"',seg,count=1); assert k==1
seg2,k=re.subn(r'\.\./ref-pdf/[ts]?\d+\.pdf#page=\d+','../ref-pdf/%s%d.pdf#page=%d'%(PFX,N,PDFPAGE),seg2,count=1); assert k==1
m=re.search(r'<meta http-equiv=content-security-policy content="[^"]*"></head>\n<body dir=rtl>\n',x); assert m
x=x[:m.start()]+seg2+x[m.end():]
x=x.replace('<script type=module ','<script type="text/plain-disabled-by-archive" '); assert 'type=module' not in x
k=REF.index('<div class="cdk-live-announcer-element'); e=REF.index('\n',k); tail=REF[e+1:]
tail,k=re.subn(r'var TARGETS = \[.*?\];',lambda m:'var TARGETS = '+json.dumps(T)+';',tail,count=1,flags=re.S); assert k==1
x=x+'\n'+tail
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x))
