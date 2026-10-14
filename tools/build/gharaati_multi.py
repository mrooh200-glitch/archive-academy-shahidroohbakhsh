import re,json,urllib.parse,html,sys
P='/home/user/archive-academy-shahidroohbakhsh/aa/p/'
U='/root/.claude/uploads/f828941e-4a2f-5bfe-9596-8ce0b171777c/'
REF=open(P+'84.html',encoding='utf-8').read()
raw=open(U+'71519218-105.html',encoding='utf-8').read()
N=105; PDFPAGE=int(sys.argv[2]) if len(sys.argv)>2 else 1; AUDIO='https://gharaati.ir/archive/tafsir/36/77-80.mp3'; NUMS=[77,78,79,80]
LIVE='https://gharaati.ir/%d8%aa%d9%81%d8%b3%db%8c%d8%b1-%d9%86%d9%88%d8%b1/#numsooreh=36&numayeh=4050'
APARAT='<div id="43078264851"><script type="text/JavaScript" src="https://www.aparat.com/embed/pqw2tqf?data[rnddiv]=43078264851&data[responsive]=yes"></script></div>'
VERSE_STARTS=['وَضَرَبَ لَنَا','رَمِيمٌ']
EXTRA=[('گفت: چه كسى این استخوان ها را در حالى','زنده خواهد كرد؟'),('معاد جسمانى است','معاد جسمانى است')]
x=raw
# 1 CSP
csp=re.search(r'<meta http-equiv="Content-Security-Policy" id="archive-csp"[^>]*>',REF).group(0)
assert x.count('<meta charset=utf-8>')>=1
x=x.replace('<meta charset=utf-8>','<meta charset=utf-8>'+csp,1)
# 2 head
mk='<style>.sf-hidden{display:none!important}</style>'
a=REF.index(mk)+len(mk); HEAD=REF[a:REF.index('</head>')+7]
m=re.search(r"<meta http-equiv=content-security-policy content=\"default-src 'none'; font-src[^>]*></head>",x); assert m
x=x[:m.start()]+HEAD+x[m.end():]
# 3 top chrome
tag='<div class="main-wrap content-main-wrap">'
bi=REF.index('dir=rtl>',REF.index('</head>'))+8; mi=REF.index(tag)
TOP=REF[bi:mi+len(tag)]
top,k=re.subn(r'<a href="https://gharaati\.ir[^"]*" rel="noopener" role="menuitem" target="_blank"><span class="ref-menu-label">نسخه‌ی زنده‌ی صفحه',lambda m_:'@@LIVE@@',TOP,count=1); assert k==1
top,k=re.subn(r'\.\./pdf/\d+\.pdf#page=\d+','../pdf/%d.pdf#page=%d'%(N,PDFPAGE),top,count=1); assert k==1
old='\n '+tag; assert x.count(old)==1
x_top_idx=x.index(old)
# 4 audio
m=re.search(r'<audio controls style=position:absolute;display:inline-block;z-index:1000;top:33px;left:260px>(.*?)</audio>',x,re.S); assert m
sp=x.find('<span class="hidden-md hidden-sm hidden-xs sf-hidden" style="font-weight:bold;position:absolute;font-size:13px;margin:35px 0 0 0',m.end()); assert 0<sp-m.end()<2000
x=x[:m.start()]+x[sp:]
anchor='<td height=14></table>'; i=x.find(anchor); assert i>0; i+=len(anchor)
x=x[:i]+'<div id="tafsir-audio-wrap"><audio controls><source type=audio/mp3 src="%s"></audio></div>'%AUDIO+x[i:]
# 5 aparat
s=x.find('<iframe width=100% height=100% allowfullscreen webkitallowfullscreen=true'); e=x.find('"></iframe>',s); assert s>0 and e>s
x=x[:s]+APARAT+x[e+len('"></iframe>'):]
# ayah number (single ayah 23)
ms=[mm for mm in re.finditer(r'(class=tafsir_ayeh[^>]*>)(.*?)(</tr>)',x,re.S) if 'bgcolor=#ffebcd' in x[mm.start()-60:mm.start()+30]]
assert len(ms)==1; m=ms[0]
AR=str.maketrans('0123456789','٠١٢٣٤٥٦٧٨٩')
parts=re.split(r'(<br\s*/?>)',m.group(2))
idx=[i for i,s_ in enumerate(parts) if not re.fullmatch(r'<br\s*/?>',s_) and re.search(r'[؀-ۿ]',s_)]
assert len(idx)==len(NUMS),(len(idx),NUMS)
for i,v in zip(idx,NUMS):
    core=parts[i].rstrip(); tail=parts[i][len(core):]
    parts[i]=core+' <span class="ayah-no" style="white-space:nowrap">﴿'+str(v).translate(AR)+'﴾</span>'+tail
x=x[:m.start(2)]+''.join(parts)+x[m.end(2):]
# page-text targets
b0=x.index('<td colspan=3 bgcolor=#ffebcd class=tafsir_ayeh>')
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
    assert NS.count(A)==1,(s0,NS.count(A))
    s=NS.find(A); e=NS.find(B,s); assert e>=0,(s0,s1); e+=len(B); st=mp[s]; en=mp[e-1]+1
    while en<len(body) and (0x64b<=ord(body[en])<=0x65f or ord(body[en])==0x670): en+=1
    return re.sub(r'\s+',' ',body[st:en]).strip()
T=[sl(*VERSE_STARTS)]+[sl(*p) for p in EXTRA]
for t in T: print(t)
# title digits
m=re.search(r'(post-title h-text">)(سوره[^<]*)(<)',x); T9=str.maketrans('0123456789','۰۱۲۳۴۵۶۷۸۹')
x=x[:m.start(2)]+m.group(2).translate(T9)+x[m.end(2):]; print(re.search(r'post-title h-text">(سوره[^<]*)<',x).group(1))
# top chrome insertion (now that live link known)
frag=urllib.parse.quote(T[0],safe='')
top2=top.replace('@@LIVE@@','<a href="'+LIVE+':~:text='+frag+'" rel="noopener" role="menuitem" target="_blank"><span class="ref-menu-label">نسخه‌ی زنده‌ی صفحه')
x=x.replace(old,top2,1)

# --- layout normalisation (menu unpinned, sidebar wrapper) ---
if 'bs-pinning-wrapper' not in x:
    o='\n <div id=menu-main class="menu main-menu-wrapper" role=navigation'
    assert x.count(o)==1
    x=x.replace(o,'\n <div class="bs-pinning-wrapper bspw-header-style-2" style=height:58.2px><div id=menu-main class="menu main-menu-wrapper bs-pinning-block smart unpinned" role=navigation',1)
    o2='\n</div>\n </header>'; assert x.count(o2)==1
    x=x.replace(o2,'\n</div></div>\n </header>',1)
x,k=re.subn(r'bs-pinning-block smart (?:pinned|unpinned)','bs-pinning-block smart unpinned',x,count=1); assert k==1
if 'class=wrapper-sticky' not in x:
    o='<div class="col-sm-4 col-xs-12 sidebar-column sidebar-column-primary" id=list>'; assert x.count(o)==1
    x=x.replace(o,'<div class=wrapper-sticky style=display:block;height:0px;width:33.3333%;margin:auto;position:relative;float:right;inset:auto;vertical-align:top><div class="col-sm-4 col-xs-12 sidebar-column sidebar-column-primary" id=list style="width:0px;inset:auto;position:absolute">',1)
    o3='\n </div>\n </div>\n <div class="col-sm-8 col-xs-12" id=content>'; assert x.count(o3)==1
    x=x.replace(o3,'\n </div>\n </div></div>\n <div class="col-sm-8 col-xs-12" id=content>',1)
else:
    x,k=re.subn(r'<div class=wrapper-sticky style=[^>]*>','<div class=wrapper-sticky style=display:block;height:0px;width:33.3333%;margin:auto;position:relative;float:right;inset:auto;vertical-align:top>',x,count=1); assert k==1
    x,k=re.subn(r'(sidebar-column-primary" id=list) style="[^"]*"',r'\1 style="width:0px;inset:auto;position:absolute"',x,count=1); assert k==1
# modules
x=x.replace('<script type=module ','<script type="text/plain-disabled-by-archive" ')
# end scripts
k=REF.index('<script id="kill-dialog-script"'); end=REF[k:]
end,kk=re.subn(r'var TARGETS = \[.*?\];',lambda m_:'var TARGETS = '+json.dumps(T)+';',end,count=1,flags=re.S); assert kk==1
end,kk=re.subn(r'var BOXES = [^;]*;','var BOXES = ['+','.join(['null']*len(T))+'];',end,count=1); assert kk==1
x=x+'\n'+end if not x.endswith('\n') else x+end
open(sys.argv[1],'w',encoding='utf-8').write(x); print(len(x))
