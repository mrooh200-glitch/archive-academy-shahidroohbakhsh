import re,sys
# خانواده‌ی «متنِ استخراج‌شده از PDF» برای منبع فارسی؛ قالب: aa/p/65.html
# اجرا: python3 -I tools/build/pdf_extract_fa.py <خروجی.html>
P='/home/user/archive-academy-shahidroohbakhsh/aa/p/'
s=open(P+'65.html',encoding='utf-8').read()
N=121; PG=571
LIVE='https://archive.org/details/abu-abdurahman-kurdi-f_barid_20171224_2243/%D8%AA%D8%A7%D8%B1%DB%8C%D8%AE%20%D8%AA%D9%85%D8%AF%D9%86-%D9%88%DB%8C%D9%84%20%D8%AF%D9%88%D8%B1%D8%A7%D9%86%D8%AA/'
TITLE='سلطه‌ی اخلاق در چین (پسرگرایی) — تاریخ تمدن، ویل دورانت'
CITE='دورانت، ویل. <i>تاریخ تمدن</i>، ج ۱: مشرق زمین، گاهواره‌ی تمدن. ترجمه‌ی احمد آرام، ع. پاشائی و امیرحسین آریان‌پور. تهران، چاپ ششم، ۱۹۹۹ م.'
T1='مادران آرزوی پسرزایی داشتند، و اگر بی‌پسر می‌ماندند، همواره شرمگین بودند، زیرا پسران بهتر از دختران در کشتزارها کار می‌کردند و در میدان‌ها می‌جنگیدند.'
T2='دختران، همچون بار، بر دوش خانواده سنگینی می‌کردند. می‌بایست آنان را با شکیبایی به عرصه‌ی رشد رسانید تا خانواده را ترک گویند و به خانه‌ی شوهر روند و در آنجا کار کنند و کارگر زایند و خانواده‌ای نو به بار آورند. در مواقع سختی، اگر دختری بر دختران متعدد خانواده افزوده می‌شد، امکان داشت که نوزاد بی‌گناه را رها کنند تا در سرمای شب بمیرد یا خوراک گرازان طعمه طلب شود.'
def sub(pat,rep,x,flags=0):
    y,k=re.subn(pat,lambda m:rep,x,count=1,flags=flags); assert k==1,pat; return y
s=sub(r'<title>.*?</title>','<title>'+TITLE+'</title>',s)
s=sub(r'href="https://sid\.ir/paper/122358/fa"','href="'+LIVE+'"',s)
s=sub(r'\.\./pdf/65\.pdf#page=2','../pdf/%d.pdf#page=%d'%(N,PG),s)
w0=s.index('<div class="cite-box">'); w1=s.index('</div>',s.index('</p>',s.index('ref-target-2')))
body='''<div class="cite-box">
<div>%s</div>
</div>

<div class="pdf-page-label">صفحه‌ی %s فایل PDF:</div>
<p class="pdf-text-fa"><span id="ref-target-1">%s</span></p>

<p class="pdf-text-fa"><span id="ref-target-2">%s</span></p>

'''%(CITE,'۵۷۱',T1,T2)
s=s[:w0]+body+s[w1:]
open(sys.argv[1],'w',encoding='utf-8').write(s); print(len(s))
