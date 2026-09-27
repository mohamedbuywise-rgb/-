import os
HERE=os.path.dirname(os.path.abspath(__file__))
import re,sys,json
sys.path.insert(0,'.')
from coverage import tt,AR
from extract import collapse_interp,TAG
def scripts(html):
    return re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',html,re.S)
LIT=re.compile(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`",re.S)
miss={}
for f in sys.argv[1:]:
    h=open(f,encoding='utf-8').read()
    code='\n'.join(scripts(h)) if f.endswith('.html') else h
    code=re.sub(r'/\*.*?\*/','',code,flags=re.S)
    code='\n'.join(re.sub(r'(^|\s)//\s.*$','',l) for l in code.split('\n'))
    for m in LIT.finditer(code):
        lit=m.group(0)[1:-1]
        if not AR.search(lit): continue
        lit=collapse_interp(lit).replace('\\n','\n').replace("\\'","'")
        for piece in TAG.sub('\n',lit).split('\n'):
            p=re.sub(r'\s+',' ',piece).strip()
            if not p or not AR.search(p): continue
            out=tt(p)
            if AR.search(out): miss[p]=miss.get(p,0)+1
print(len(miss))
for k in list(miss)[:400]: print(k[:140])
