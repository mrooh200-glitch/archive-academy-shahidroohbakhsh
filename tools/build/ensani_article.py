import re,json,urllib.parse,html,sys
P='/home/user/archive-academy-shahidroohbakhsh/aa/p/'
U='/root/.claude/uploads/f828941e-4a2f-5bfe-9596-8ce0b171777c/'
REF=open(P+'61.html',encoding='utf-8').read()
RAIL='<style id="rail-safe-zone">@media (min-width:860px){body{padding-left:80px !important;padding-right:80px !important;box-sizing:border-box !important;}}</style>\n'
R77=open(P+'77.html',encoding='utf-8').read()
raw=open(U+'c10fb2fe-125.html',encoding='utf-8').read()
N=125; PDFPAGE=int(sys.argv[2]) if len(sys.argv)>2 else 1
LIVE='https://ensani.ir/fa/article/88253/%D8%AC%D8%B1%D8%A7%DB%8C%D9%85-%D8%AF%D8%B1-%D8%AD%D9%82%D9%88%D9%82-%DA%A9%DB%8C%D9%81%D8%B1%DB%8C-%DB%8C%D9%87%D9%88%D8%AF'
LIVEPDF='https://haftasman.urd.ac.ir/article_70701_0618130d0a38a37556ebd5317d5e445e.pdf'
START,END_='اگرمردم جنگ کنند','به حضور داوران ادا نماید.'
x=raw
def blk(i,src=REF):
    m=re.search(r'<(style|script)[^>]*\bid="%s"[^>]*>.*?</\1>\n?'%i,src,re.S); assert m,i; return m.group(0)
csp=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',REF).group(0)
x=re.sub(r'<meta http-equiv=content-security-policy[^>]*>','',x)
assert x.count('<meta charset=utf-8>')>=1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
# wrap <br>-separated lines of the article body into <p>
s0=x.index('<div align=justify>')+len('<div align=justify>'); e0=x.index('</div>',s0)
inner=x[s0:e0]
lines=[l for l in re.split(r'<br>\s*\n?',inner)]
wrapped=''.join('<p>'+l.strip()+'</p>\n' for l in lines if l.strip())
x=x[:s0]+wrapped+x[e0:]
print('paragraphs',len(lines))
body=re.sub(r'<style.*?</style>|<script.*?</script>','',x[s0:],flags=re.S); body=html.unescape(re.sub(r'<[^>]+>',' ',body))
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
def sl(s0_,s1_):
    A=''.join(norm(c) for c in s0_); B=''.join(norm(c) for c in s1_)
    assert NS.count(A)==1,(s0_,NS.count(A)); s=NS.find(A); e=NS.find(B,s); assert e>=0; e+=len(B)
    return re.sub(r'\s+',' ',body[mp[s]:mp[e-1]+1]).strip()
HT=sl(START,END_); print('TARGET:',HT)
T=[HT]
words=HT.rstrip('.').split(); frag=urllib.parse.quote(' '.join(words[:4]),safe='')+','+urllib.parse.quote(' '.join(words[-4:]),safe='')
art='''<style id="article-indent-style">
  div[align=justify] p:not(.fa-original-en) { text-indent: 0.4cm !important; font-family: Vazirmatn, Tahoma, Arial, sans-serif !important; font-size: 16px !important; font-weight: 500 !important; line-height: 1.9 !important; text-align: right !important; margin: 0 0 22px !important; }
</style>
'''
extra=open('tools/build/ensani_article_wide.css').read() if len(sys.argv)>3 else ''
wide='<style id="wide-layout-fix">\n'+extra+'\n</style>\n'
fonts=''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*fonts[^>]*>',REF))
head=fonts+'\n'+blk('brand-style')+blk('chrome-lock')+blk('dark-toggle-lock')+art+blk('heading-style')+wide+RAIL+'<style id="dark-pseudo-fix">body.dark-mode .block-header::before{background:transparent !important;}</style>\n'
assert x.count('</head>')==1
x=x.replace('</head>',head+'</head>',1)
ci=REF.index('<div class="side-rail right">'); ce=REF.index('<div class="ref-extract-box"'); chrome=REF[ci:ce]
chrome,k=re.subn(r'<a href="https://shefayekhatam\.ir/browse[^"]*"','<a href="'+LIVE+'#:~:text='+frag+'"',chrome,count=1); assert k==1
chrome,k=re.subn(r'<a href="https://shefayekhatam\.ir/article[^"]*"[^>]*><span class="ref-menu-label">نسخه‌ی زنده‌ی PDF</span></a>','',chrome,count=1); assert k==1
chrome=chrome.replace('برای مواقعی که نسخه‌ی زنده در دسترس نیست','تهیه‌شده از صفحه‌ی وب؛ این منبع، نسخه‌ی رسمیِ PDF ندارد')
chrome,k=re.subn(r'\.\./pdf/61\.pdf#page=3','../pdf/%d.pdf#page=%d'%(N,PDFPAGE),chrome,count=1); assert k==1
m=re.search(r'<body[^>]*>',x); assert m
x=x[:m.end()]+chrome+x[m.end():]
tail=REF[REF.index('<script id="kill-dialog-script"'):]
bt61=blk('back-to-top-script'); bt77=blk('back-to-top-script',R77); assert bt61 in tail
tail=tail.replace(bt61,bt77)
tail,k=re.subn(r'var TARGETS = \[.*?\];',lambda m_:'var TARGETS = '+json.dumps(T)+';',tail,count=1,flags=re.S); assert k==1
tail,k=re.subn(r'var BOXES = [^;]*;','var BOXES = [null];',tail,count=1); assert k==1
tail=tail.replace('var SKIP_ARROW = true;','var SKIP_ARROW = false;')
x=x+'\n'+tail
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x), 'SKIP_ARROW false' if 'SKIP_ARROW = false' in x else 'skip?')
