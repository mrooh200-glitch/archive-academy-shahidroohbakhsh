import re,json,urllib.parse,html,sys,os
PFX=os.environ.get('PFX','')  # پیشوندِ نامِ فایل: t = متن اصلی، s = مطالعات، خالی = فایل‌هایِ قدیمیِ بدونِ پیشوند
P='/home/user/archive-academy-shahidroohbakhsh/aa/ref/'
U='/root/.claude/uploads/f828941e-4a2f-5bfe-9596-8ce0b171777c/'
REF=open(P+'61.html',encoding='utf-8').read()
RAIL='<style id="rail-safe-zone">@media (min-width:860px){body{padding-left:80px !important;padding-right:80px !important;box-sizing:border-box !important;}}</style>\n'
raw=open(U+'fe8f6b42-104.html',encoding='utf-8').read()
N=104
LIVE='https://www.ensani.ir/fa/article?ArticleSearch%5Btitle%5D=%D8%B1%D9%88%DB%8C%DA%A9%D8%B1%D8%AF-%D8%A7%D9%86%D8%B3%D8%A7%D9%86-%D8%B4%D9%86%D8%A7%D8%AE%D8%AA%DB%8C-%D9%88%DB%8C%D9%84%D9%87%D9%84%D9%85-%D8%A7%D8%B4%D9%85%DB%8C%D8%AA-%D8%A8%D9%87-%D8%AF%DB%8C%D9%86&ArticleSearch%5BsortBy%5D=relevance'
BOX=[(20,'خدایی که قانون‌گذار و ناظر بر اجرای آن است، بر آنچه در باطن انسان می‌گذرد، آگاه بوده و به فرمان‌برداران پاداش و سرپیچی‌کنندگان کیفر می‌دهد، و در عین حال خودش از هر بدی مبرا و به هر خوبی آراسته است.'),
     (22,'در نظر اشمیت، ابتدایی‌ترین نوع بشر، صرف‌نظر از هر جا که یافت شده، به یک موجود متعالی باور داشته است.'),
     (24,'قوانین نظم اخلاقی را وضع کرده و قضاوت می‌کند و جزا و پاداش می‌دهد.')]
CITE='علمی، قربان؛ و انجم‌روز، سیده سوزان. (۱۴۰۴). «رویکرد انسان‌شناختی ویلهلم اشمیت به دین». <i>پژوهش‌های علم و دین</i>، ۱۶(۱)، ۱۶۷–۱۹۵.'
FA=str.maketrans('0123456789','۰۱۲۳۴۵۶۷۸۹')
x=raw
def blk(i):
    m=re.search(r'<(style|script)[^>]*\bid="%s"[^>]*>.*?</\1>\n?'%i,REF,re.S); assert m,i; return m.group(0)
# CSP
csp=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',REF).group(0)
print('raw csp metas',len(re.findall('(?i)content-security-policy',raw)))
x=re.sub(r'<meta http-equiv=content-security-policy[^>]*>','',x)
assert x.count('<meta charset=utf-8>')>=1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
# page-text targets from abstract
b0=x.index('id=article-abstract-')
body=re.sub(r'<style.*?</style>|<script.*?</script>','',x[b0:],flags=re.S); body=html.unescape(re.sub(r'<[^>]+>',' ',body))
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
    assert NS.count(A)==1,(s0,NS.count(A)); s=NS.find(A); e=NS.find(B,s); assert e>=0; e+=len(B)
    return re.sub(r'\s+',' ',body[mp[s]:mp[e-1]+1]).strip()
HT=sl('در باورهای این مردم','اخلاقی وجود دارد'); print('HTML target:',HT)
T=[t for _,t in BOX]+[HT]
words=HT.split(); frag=urllib.parse.quote(' '.join(words[:4]),safe='')+','+urllib.parse.quote(' '.join(words[-3:]),safe='')
# head additions
art='''<style id="article-indent-style">
  .article-item .well { line-height: 2 !important; }
  .article-item .well:not(.fa-original-en) { text-indent: 0.4cm !important; font-family: Vazirmatn, Tahoma, Arial, sans-serif !important; font-size: 16px !important; font-weight: 500 !important; line-height: 1.9 !important; text-align: right !important; margin-bottom: 22px !important; }
</style>
'''
wide='''<style id="wide-layout-fix">
@media (min-width:860px){.ref-extract-box{width:100% !important;max-width:764px !important;padding-left:22px !important;padding-right:18px !important;margin-left:auto !important;margin-right:auto !important;}}
.article-index .row>.col-md-3,.article-index .row>.filters-column{display:none !important;}
@media (min-width:860px){.article-index>.container{width:100% !important;max-width:100% !important;padding-left:0 !important;padding-right:0 !important;}.article-index .row{justify-content:center !important;margin-left:0 !important;margin-right:0 !important;}.article-index .row>.col-md-6{float:none !important;left:auto !important;right:auto !important;width:100% !important;max-width:760px !important;flex:0 1 760px !important;margin-left:auto !important;margin-right:auto !important;padding-left:0 !important;padding-right:0 !important;}}
</style>
'''
fonts=''.join(re.findall(r'<link rel="(?:preconnect|stylesheet)"[^>]*fonts[^>]*>',REF))
dkfix='<style id="dark-pseudo-fix">body.dark-mode .block-header::before{background:transparent !important;}</style>\n'
head=fonts+'\n'+blk('brand-style')+blk('chrome-lock')+blk('dark-toggle-lock')+blk('ref-extract-style')+art+blk('heading-style')+wide+RAIL+dkfix
extra=open('/tmp/claude-0/x/b/104_extra.css').read() if len(sys.argv)>2 else ''
if extra: head+='<style id="mobile-fluid-fix">\n'+extra+'\n</style>\n'
assert x.count('</head>')==1
x=x.replace('</head>',head+'</head>',1)
# chrome
ci=REF.index('<div class="side-rail right">'); ce=REF.index('<div class="ref-extract-box"'); chrome=REF[ci:ce]
chrome,k=re.subn(r'<a href="https://shefayekhatam[^"]*" rel="noopener" role="menuitem" target="_blank"><span class="ref-menu-label">نسخه‌ی زنده‌ی صفحه</span></a><a href="https://shefayekhatam[^"]*"[^>]*><span class="ref-menu-label">نسخه‌ی زنده‌ی PDF</span></a><a href="\.\./ref-pdf/61\.pdf#page=3"',
   lambda m:'<a href="'+LIVE+'#:~:text='+frag+'" rel="noopener" role="menuitem" target="_blank"><span class="ref-menu-label">نسخه‌ی زنده‌ی صفحه</span></a><a href="../ref-pdf/%s%d.pdf#page=%d"'%(PFX,N,BOX[0][0]),chrome); assert k==1,k
chrome=chrome.replace('<span class="ref-menu-sub">برای مواقعی که نسخه‌ی زنده در دسترس نیست</span>','')
box='<div class="ref-extract-box" dir="rtl">\n<span class="ref-extract-label">متن‌های مرتبط در نسخه‌ی PDF مقاله (در صفحه‌ی وب نیامده است):</span>\n'
for pg,t in BOX:
    box+='<span class="ref-extract-label ref-extract-sub">صفحه‌ی %s فایل PDF:</span>\n<p class="ref-extract-text"><span>%s</span></p>\n'%(str(pg).translate(FA),t)
box+='<div class="ref-extract-cite" style="direction:rtl;text-align:right;font-family:Vazirmatn,Tahoma,Arial,sans-serif">%s</div>\n</div>\n'%CITE
m=re.search(r'<body[^>]*>',x); assert m
x=x[:m.end()]+chrome+box+x[m.end():]
# modules? (none expected)
print('modules',x.count('<script type=module'))
tail=REF[REF.index('<script id="kill-dialog-script"'):]
tail,k=re.subn(r'var TARGETS = \[.*?\];',lambda m_:'var TARGETS = '+json.dumps(T)+';',tail,count=1,flags=re.S); assert k==1
tail,k=re.subn(r'var BOXES = [^;]*;','var BOXES = ['+','.join(['null']*len(T))+'];',tail,count=1); assert k==1
x=x+'\n'+tail
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x))
