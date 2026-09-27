import os
HERE=os.path.dirname(os.path.abspath(__file__))
import json,re,glob
AR=re.compile(r'[\u0600-\u06FF]')
def load(seg,files):
    ks=json.load(open(seg,encoding='utf-8'))
    tr={}
    for f in files:
        for line in open(f,encoding='utf-8'):
            line=line.rstrip('\n')
            if not line: continue
            i,_,en=line.partition('\t'); tr[int(i)]=en
    return [(ks[i],tr.get(i,'')) for i in range(len(ks))]
pairs=load(os.path.join(HERE,'segments.json'),sorted(glob.glob('t[0-9].tsv')))+load(os.path.join(HERE,'segments_be.json'),['be.tsv'])+load(os.path.join(HERE,'segments_static.json'),['s0.tsv'])
extra={
 'اللغة':'Language','اللغة والعرض':'Language','العربية':'العربية','English':'English',
 'سجّل مصروفك':'Log your expense','حسابي':'My account','مساعد':'Assistant','ديون':'Debts','يومي':'Daily','شهري':'Monthly',
 'نصايح':'Tips','خطوات أذكى للتوفير':'Smarter savings steps','اسأل دبّر':'Ask Dabbar',
 'مصروف':'Expense','دخل':'Income','الكل':'All','حفظ':'Save','إلغاء':'Cancel','حذف':'Delete','تعديل':'Edit',
}
extra.update({
 'أهلًا بك في دبّر':'Welcome to Dabbar',
 'في أقل من 3 دقائق هنعرف فلوسك بتروح فين ونطلع لك أول فرصة توفير.':"In under 3 minutes we'll see where your money goes and find your first savings opportunity.",
 'إعداد سريع — اختياري':'Quick setup — optional',
 'قولنا أرقام تقريبية عشان حساب المتبقي وفرصة التوفير يبقوا أقرب لواقعك. تقدر تخطي دلوقتي وتكمل التسجيل فورًا.':'Give us rough numbers so the remaining balance and savings opportunity are closer to your reality. You can skip for now and continue signing up right away.',
 'الآن سجّل أول مصروف':'Now log your first expense',
 'اضغط على «كتابة» واكتب مثلًا: «دفعت 180 جنيه غدا». دبّر هيفهم المبلغ والفئة ويطلب تأكيدك قبل الحفظ.':'Tap "Type" and write, for example: "paid 180 EGP for lunch". Dabbar will understand the amount and category and ask you to confirm before saving.',
 'ممتاز. كمل العملية الثانية':'Excellent. Continue with the second transaction',
 'سجل مصروفًا من فئة مختلفة حتى نبدأ نفهم نمط صرفك الحقيقي.':'Log an expense from a different category so we can start understanding your real spending pattern.',
 'بدأنا نرى نمطك':"We're starting to see your pattern",
 'سجل عملية ثالثة، وبعدها هنعرض لك أول فرصة توفير مبنية على بياناتك الفعلية.':"Log a third transaction, and then we'll show you your first savings opportunity based on your actual data.",
 'دبّر فهم فلوسك':'Dabbar understood your money',
 'دي أول لقطة من نمط صرفك الحقيقي. من هنا تقدر تحول الملاحظة لخطة توفير قابلة للمتابعة.':'This is the first snapshot of your real spending pattern. From here you can turn the insight into a trackable savings plan.',
 'تخطي الآن':'Skip for now','ابدأ الآن':'Start now','حفظ والمتابعة':'Save and continue','اعمل لي خطة توفير':'Make me a savings plan','سجّل الآن':'Log now',
 'مصروفاتك اليومية':'Your daily expenses','إجمالي المسجل':'Total logged','أكثر فئة ظاهرة':'Top visible category','جاهز':'Ready',
 'أول فرصة توفير بعد اكتمال البيانات':'First savings opportunity once data is complete',
 'تم! اتضافلك {} عملية{}':'Done! {} transactions added{}',
 '"المتاح" = دخلك أو ميزانيتك، ناقص اللي صرفته فعلًا بس.':'"Available" = your income or budget, minus only what you\'ve actually spent.',
 'دفع':'Payment','لسه':'Not yet','حذف كشف الحساب':'Delete account statement','وحدة':'Unit','خطأ غير متوقع':'Unexpected error',
 'سجّل بكرة قبل ١٠ الصبح = نقاط ×٢ ⚡':'Log tomorrow before 10 AM = points ×2 ⚡',
 'المتاح':'Available','إضافة':'Add','تثبيت التطبيق':'Install app','تثبيت':'Install','تثبيت دبّر':'Install Dabbar','التخطيط':'Planning',
 'افتح في المتصفح':'Open in browser','إضافة إلى الشاشة الرئيسية':'Add to Home Screen','إضافة للشاشة الرئيسية':'Add to Home Screen',
 'ص':'AM','م':'PM','ج.م':'EGP',
})

# ---- نصوص بيولّدها السيرفر وبتتخزن/تظهر للمستخدم (وصف الحركات البنكية، أسماء البنوك، الفئات)
def A(ar,en): extra[ar]=en
for ar,en in {
 'استرداد مبلغ':'Refund','سحب من ATM':'ATM withdrawal','سحب من وكيل':'Agent withdrawal','سحب نقدي':'Cash withdrawal',
 'إيداع نقدي':'Cash deposit','إيداع في الحساب':'Account deposit','مرتب':'Salary','راتب':'Salary',
 'تحويل بين حساباتك':'Transfer between your accounts','تحويل وارد':'Incoming transfer','تحويل صادر':'Outgoing transfer',
 'شحن رصيد':'Balance top-up','سداد فاتورة':'Bill payment','شراء بالبطاقة':'Card purchase','مصروف عام':'General expense',
 'رسوم الخدمة':'Service fee','التقرير الشهري':'Monthly report','التقرير الأسبوعي':'Weekly report','بنك / محفظة':'Bank / wallet',
 'QNB الأهلي':'QNB Alahli','بنك البركة':'Al Baraka Bank','بنك أبوظبي الأول مصر (FAB)':'First Abu Dhabi Bank Egypt (FAB)','ADIB مصر':'ADIB Egypt',
 'كريدي أجريكول مصر':'Crédit Agricole Egypt','بنك فيصل الإسلامي':'Faisal Islamic Bank','مشرق مصر':'Mashreq Egypt','بنك المصرف المتحد':'United Bank',
 'بنك الإسكندرية':'Bank of Alexandria','بنك القاهرة':'Banque du Caire','بنك التعمير والإسكان':'Housing & Development Bank','البنك المصري الخليجي':'Egyptian Gulf Bank',
 'بنك قناة السويس':'Suez Canal Bank','بلوم مصر':'Blom Egypt','البنك الأهلي الكويتي - مصر':'Ahli Bank of Kuwait - Egypt','الإمارات دبي الوطني مصر':'Emirates NBD Egypt',
 'البنك العربي':'Arab Bank','بنك ناصر الاجتماعي':'Nasser Social Bank','البنك الزراعي المصري':'Agricultural Bank of Egypt','البنك العربي للاستثمار (aiBANK)':'Arab Investment Bank (aiBANK)',
 'بنك تنمية الصادرات':'Export Development Bank','بنك التنمية الصناعية':'Industrial Development Bank','التجاري وفا بنك':'Attijariwafa Bank','ميزة':'Meeza','كونتاكت':'Contact',
 'اتصالات كاش (e& money)':'Etisalat Cash (e& money)','أورنج كاش':'Orange Cash','إنستاباي':'InstaPay','فوري':'Fawry','أمان':'Aman','موبي كاش':'MobiCash','فودافون كاش':'Vodafone Cash',
 'البنك الأهلي المصري':'National Bank of Egypt','بنك مصر':'Banque Misr',
}.items(): A(ar,en)
extra_patterns=[
 ['استرداد من {}','Refund from {}'],['شحن رصيد ({})','Balance top-up ({})'],['تحويل بين حساباتك (رسوم {})','Transfer between your accounts (fee {})'],
 ['من محفظتك إلى {}','From your wallet to {}'],['من حسابك إلى {}','From your account to {}'],['من {} إلى {}','From {} to {}'],
]
for lab,en_lab,who_ar,who_en in [('تحويل وارد','Incoming transfer',' من {}',' from {}'),('تحويل صادر','Outgoing transfer',' إلى {}',' to {}')]:
    for insta_ar,insta_en in [('',''),(' عبر انستاباي',' via InstaPay')]:
        for fee_ar,fee_en in [('',''),(' (رسوم {})',' (fee {})')]:
            extra_patterns.append([lab+who_ar+insta_ar+fee_ar,en_lab+who_en+insta_en+fee_en])
exact={};patterns=[]
for ar,en in {
 'اكتب اسم عشان الأيقونة تتحدد تلقائي':'Type a name and the icon will be picked automatically',
 'بنسجل...':'Recording...','بنجهز العملية...':'Preparing the transaction...','بنصنّفها...':'Classifying it...','بنسجلها في سجلك...':'Logging it in your record...',
 'قربت من حد ميزانيتك':"You're close to your budget limit",
 'صرفت {}% من ميزانية الشهر ({} من {} ج.م). جرّب تراجع أكبر فئة صرف عندك.':"You've spent {}% of this month's budget ({} of {} EGP). Try reviewing your biggest spending category.",
 'لسه محددتش ميزانية الشهر':"You haven't set this month's budget yet",
 'صرفت {} ج.م لحد دلوقتي من غير سقف محدد. حدّد ميزانية عشان أقدر أنبهك قبل ما تعدّيها.':"You've spent {} EGP so far with no set limit. Set a budget so I can warn you before you go over it.",
 'ادخارك ممتاز الشهر ده':'Your savings are excellent this month',
 'فضل معاك {} ج.م من دخلك — وصلت لهدف الـ20% تقريبًا. استمر كده 👏':"You kept {} EGP of your income — nearly hitting the 20% goal. Keep it up 👏",
 'احتياجاتك تحت السيطرة':'Your needs are under control',
 'مصاريف الاحتياجات الأساسية (أكل، مواصلات...) في حدود معقولة: {} ج.م.':'Your essential needs spending (food, transport...) is at a reasonable level: {} EGP.',
 'وقفة صغيرة مع الرغبات':'A small pause on wants',
 'مصاريف الرغبات (اللي مش أساسية) وصلت لـ{} ج.م. لو قللتها شوية هيفضل معاك أكتر.':'Non-essential (wants) spending reached {} EGP. Cutting it back a bit will leave you with more.',
 'أكبر فئة صرف عندك':'Your biggest spending category',
 'فئة "{}" وحدها أخدت {}% من مصاريف الشهر ({} ج.م). مش مشكلة، بس يستاهل نظرة.':'"{}" alone took {}% of this month\'s spending ({} EGP). Not a problem, but worth a look.',
 'آخر حركة سجّلتها':'Your latest logged transaction',
 '{} بقيمة {}.':'{} worth {}.',
 'صرفت أقل من الشهر اللي فات':'You spent less than last month',
 'صرفك أقل بنسبة {}% ({} بدل {}). استمر كده 👏':'Your spending is down {}% ({} instead of {}). Keep it up 👏',
 '{} أيام متتالية بتسجّل فيهم':'{} days in a row you\'ve been logging',
 'بتسجّل مصاريفك بانتظام من {} أيام. الاستمرارية دي سر السيطرة على أي خطة 🙌':"You've logged your expenses regularly for {} days. That consistency is the secret to controlling any plan 🙌",
 'قربت من هدفك المالي':"You're close to your financial goal",
 'وصلت لـ{}% من هدف "{}" ({} من {}). كمّل بنفس الروح 💪':'You reached {}% of the "{}" goal ({} of {}). Keep the same spirit 💪',
 'سجّلت مصاريفك النهاردة':"You've logged today's expenses",
 '{} عملية بإجمالي {} ج.م{}.':'{} transactions totaling {} EGP{}.',
 'مقدرناش نجيب بياناتك دلوقتي. جرب تاني كمان شوية.':"Couldn't fetch your data right now. Try again in a moment.",
 '+ إضافة حد لفئة':'+ Add a category limit','التزامات شهرية متوقعة (إيجار / اشتراكات)':'Expected monthly commitments (rent / subscriptions)',
 '+ إضافة التزام جديد':'+ Add a new commitment','إضافة حد لفئة':'Add a category limit','اسم الفئة':'Category name','الحد الشهري':'Monthly limit','حفظ الحد':'Save limit',
 'إضافة التزام جديد':'Add a new commitment','اسم الالتزام':'Commitment name','المبلغ الشهري':'Monthly amount','حفظ الالتزام':'Save commitment',
 'كل عملياتك':'All your transactions','اكتب اسم الفئة الأول.':'Enter the category name first.','اكتب مبلغ الحد.':'Enter the limit amount.',
 'الأيقونة اتحددت تلقائي':'The icon was picked automatically','اكتب اسم ومبلغ الالتزام.':'Enter the commitment name and amount.',
 '💸 المتاح ليك تصرفه دلوقتي':'💸 What you can spend right now','صرفت فعليًا':'Actually spent','سلفة مستلَفة':'Borrowed loan',
 'اشتراكات ثابتة':'Fixed subscriptions',
 'عندك {} علّمت عليهم إنك مش بتستخدمهم، وبتفضل بتدفعهم شهريًا.':"You have {} you marked as unused, and you're still paying for them monthly.",
 'اشتراكات علّمت عليها إنك مش بتستخدمها، وبتفضل بتتخصم شهريًا.':"Subscriptions you marked as unused, and they're still charged monthly.",
 '🚫 وريني الاشتراكات':'🚫 Show me the subscriptions','زيادة أسعار':'Price increases',
 '{} سعرهم عن الشهر اللي فات — يستاهل تراجعهم.':"{} got pricier than last month — worth reviewing.",
 'في اشتراكات زادت في السعر عن الشهر اللي فات.':'Some subscriptions got pricier than last month.','📈 وريني الاشتراكات اللي غلت':'📈 Show me what got pricier',
 '{} — أكبر فئة صرف':'{} — biggest spending category','فئات كمالية':'Non-essential categories',
 'صرفت الشهر ده {} على "{}" — أكتر فئة في مصروفك. تقليل بسيط فيها ممكن يوفر لك المبلغ ده.':'You spent {} on "{}" this month — your top category. A small cut there could save you this amount.',
 'تقليل بسيط في الفئات الكمالية زي التسوق والترفيه ممكن يوفر لك المبلغ ده.':'A small cut in non-essential categories like shopping and entertainment could save you this amount.',
 '🛍️ وريني تفاصيل الفئة':'🛍️ Show me the category details',
 '📈 زاد {}% عن الشهر اللي فات':'📈 Up {}% from last month','مفيش عمليات في المدة دي.':'No transactions in this period.',
 'متوسط العملية':'Average transaction','أيام فيها صرف':'Days with spending','عرض المزيد ({}) ⌄':'Show more ({}) ⌄',
 'اتحفظت العملية':'Transaction saved','📅 هتتسجّل في: {}':'📅 Will be logged on: {}','📝 بنجهز الدين...':'Preparing the debt...','🧮 بنراجع البيانات...':'Reviewing the data...','💾 بنسجله في سجلك...':'Logging it in your record...',
 'إجمالي أيامك النشطة':'Your total active days','سجّل مصروفك بسرعة':'Log your expense fast','كتابة، صوت، أو فاتورة — في ثواني':'Type, voice, or a receipt — in seconds',
 'ربط الحساب أو مراجعة':'Link account or review','دهب، صناديق، أصول':'Gold, funds, assets','اضغط تشوف كل عمليات دخلك':'Tap to see all your income transactions',
 'إجمالي المحفظة':'Portfolio total','عدد الأصول':'Number of assets','التفاصيل':'Details','💰 عمليات الدخل —':'💰 Income transactions —',
}.items(): extra[ar]=en

def add(ar,en):
    ar=re.sub(r'\s+',' ',ar).strip()
    if not en or not AR.search(ar): return
    if ar.startswith('[/') or 'test(' in ar or '.replace(' in ar: return
    variants=[ar]
    if ar[0]=='n' and len(ar)>1 and ord(ar[1])>127: variants.append(ar[1:])
    for v in variants:
        if '{}' in v: patterns.append([v,en])
        else: exact.setdefault(v,en)
for ar,en in pairs: add(ar,en)
for ar,en in extra.items(): exact[ar]=en
for ar,en in extra_patterns: patterns.append([ar,en])
out='window.DABBAR_I18N_EN='+json.dumps({'exact':exact,'patterns':patterns},ensure_ascii=False,separators=(',',':'))+';\n'
open(os.path.join(HERE,'../../public/app/i18n-en.js'),'w',encoding='utf-8').write(out)
# نسخة JSON للسيرفر
json.dump({'exact':exact,'patterns':patterns},open(os.path.join(HERE,'../../lib/i18n-en.json'),'w',encoding='utf-8'),ensure_ascii=False,separators=(',',':'))
print(len(exact),len(patterns),len(out)//1024,'KB')
