import os
HERE=os.path.dirname(os.path.abspath(__file__))
import re,json,sys
from html.parser import HTMLParser
AR=re.compile(r'[\u0600-\u06FF]')
d=json.load(open(os.path.join(HERE,'../../lib/i18n-en.json'),encoding='utf-8'))
exact=d['exact']
pats=[]
for ar,en in d['patterns']:
    parts=ar.split('{}')
    pats.append((re.compile('^'+'(.+?)'.join(re.escape(p) for p in parts)+'$'),en,parts[0],len(ar.replace('{}',''))))
pats.sort(key=lambda p:-p[3])
def digits(s):
    s=s.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789')).replace('٬',',').replace('٫','.').replace('٪','%').replace('؟','?').replace('،',',').replace('؛',';')
    return s
def generic(s):
    s=digits(s)
    return re.sub('ج\\.م\\.?','EGP',s).replace('جنيه','EGP').replace('ريال','SAR').replace('دولار','USD').replace('يورو','EUR')
def split_t(core,sep,depth):
    j=(', ' if sep=='، ' else sep).join(tt(x,depth+1) for x in core.split(sep))
    return None if AR.search(j) else j
def core_t(core,depth=0):
    if core in exact: return exact[core]
    g=generic(core)
    if not AR.search(g): return g
    if g in exact: return exact[g]
    if depth<3 and '"' in core[1:]:
        q=split_t(core,'"',depth)
        if q is not None: return q
    for rx,en,first,w in pats:
        if first and not core.startswith(first): continue
        m=rx.match(core)
        if m:
            if w<8 and any(len(x)>30 for x in m.groups()): continue
            caps=[tt(x,depth+1) if depth<3 else generic(x) for x in m.groups()]
            n=[0]
            def sub(mm):
                if mm.group(1): return caps[int(mm.group(1))-1] if int(mm.group(1))<=len(caps) else ''
                v=caps[n[0]] if n[0]<len(caps) else ''; n[0]+=1; return v
            return re.sub(r'\{(\d*)\}',sub,en)
    for sep in [' · ',' — ',' | ',' - ','\n','، ',': ','«','»']:
        if sep in core[1:] and depth<3:
            r=split_t(core,sep,depth)
            if r is not None: return r
    return g
def tt(text,depth=0):
    if not AR.search(text): return text
    core=re.sub(r'\s+',' ',text.strip())
    return core_t(core,depth) if core else text
class P(HTMLParser):
    def __init__(s): super().__init__(); s.skip=0; s.miss=[]
    def handle_starttag(s,tag,attrs):
        if tag in('script','style','textarea'): s.skip+=1
        for k,v in attrs:
            if k in('placeholder','title','aria-label','alt') and v and AR.search(v):
                o=tt(v)
                if AR.search(o): s.miss.append(re.sub(r'\s+',' ',v.strip()))
    def handle_endtag(s,tag):
        if tag in('script','style','textarea') and s.skip: s.skip-=1
    def handle_data(s,data):
        if s.skip or not AR.search(data): return
        o=tt(data)
        if AR.search(o): s.miss.append(re.sub(r'\s+',' ',data.strip()))
if __name__=='__main__':
    for f in sys.argv[1:]:
        p=P(); p.feed(re.sub(r'<!--.*?-->','',open(f,encoding='utf-8').read(),flags=re.S))
        u=list(dict.fromkeys(p.miss))
        print(f.split('/')[-1],'untranslated static nodes:',len(u))
        for m in u[:25]: print('   ',m[:110])
