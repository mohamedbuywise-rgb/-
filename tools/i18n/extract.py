import re,json,sys
AR=re.compile(r'[\u0600-\u06FF]')
def strip_comments(t):
    t=re.sub(r'<!--.*?-->','',t,flags=re.S)
    t=re.sub(r'/\*.*?\*/','',t,flags=re.S)
    out=[]
    for l in t.split('\n'):
        m=re.search(r'(^|[\s;,{}()])//\s',l)
        if m and not re.search(r'https?:\s*$',l[:m.start()+1]): l=l[:m.start()]
        out.append(l)
    return '\n'.join(out)
def collapse_interp(t):
    # replace ${...} (balanced braces) with {}
    res=[];i=0
    while i<len(t):
        if t.startswith('${',i):
            d=1;j=i+2
            while j<len(t) and d>0:
                if t[j]=='{': d+=1
                elif t[j]=='}': d-=1
                j+=1
            res.append('{}'); i=j
        else: res.append(t[i]); i+=1
    return ''.join(res)
TAG=re.compile(r'</?[a-zA-Z][^<>]{0,400}>')
def segments(text):
    t=strip_comments(text)
    t=collapse_interp(t)
    # attributes with Arabic
    attrs=re.findall(r'(?:placeholder|title|aria-label|alt|label)="([^"]*[\u0600-\u06FF][^"]*)"',t)
    t=TAG.sub('\n',t)
    segs=[]
    for l in t.split('\n'):
        for m in re.finditer(r"[^'\"`;=\\]*[\u0600-\u06FF][^'\"`;=\\]*",l):
            segs.append(m.group(0))
    segs+=attrs
    out={}
    for s in segs:
        k=re.sub(r'\s+',' ',s).strip(' ,')
        if not AR.search(k): continue
        if len(k)<2: continue
        out[k]=1
    return list(out)
if __name__=='__main__':
    files=sys.argv[1:]
    allseg={}
    for f in files:
        for k in segments(open(f,encoding='utf-8').read()): allseg[k]=1
    ks=list(allseg)
    json.dump(ks,open('/home/claude/i18n/segments.json','w',encoding='utf-8'),ensure_ascii=False,indent=0)
    print(len(ks),sum(len(k) for k in ks))
