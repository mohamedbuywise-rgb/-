// قايمة أسماء/أرقام مرسلي الـ SMS الخاصة بالبنوك والمحافظ الإلكترونية والتحويلات الفورية في مصر.
// المصدر: الاسم اللي الجهة بتبعت بيه الرسالة (Sender ID) زي ما بيظهر على شاشة المستخدم.
// ملحوظة: الجهات بتضيف/تغيّر الـ Sender ID بين فترة وأخرى، ولذلك في طبقتين للتعرّف:
//   1) matchBankSender: مطابقة اسم المرسل بقايمة الأسماء (بتحمي من التطابق الجزئي الغلط لأسماء قصيرة زي "WE").
//   2) detectBankFromText: لو اسم المرسل مش معروف، بندوّر على اسم الجهة جوه نص الرسالة نفسه (بالعربي أو الإنجليزي).
// المفتاح (key) بيتربط بشعارات الداشبورد؛ أي مفتاح جديد بيظهر بأول حروف اسمه تلقائيًا.

export const EGYPT_BANK_WALLET_SENDERS = [
  // ============ بنوك ============
  { key: 'cib', label: 'CIB', senders: ['CIB', 'CIB EGYPT', 'CIB-Egypt', 'CIBEG', 'CIB Bank'], text: ['cib', 'commercial international bank', 'التجاري الدولي'] },
  { key: 'nbe', label: 'البنك الأهلي المصري', senders: ['NBE', 'AHLY', 'National Bank', 'NBE Egypt', 'AlAhly', 'Al Ahly', 'NBE-Bank'], text: ['nbe', 'national bank of egypt', 'البنك الاهلي المصري', 'الاهلي المصري'] },
  { key: 'banque_misr', label: 'بنك مصر', senders: ['Banque Misr', 'BanqueMisr', 'BM', 'BMisr', 'Misr Bank', 'BANQUE MISR'], text: ['banque misr', 'بنك مصر'] },
  { key: 'qnb', label: 'QNB الأهلي', senders: ['QNB', 'QNB ALAHLI', 'QNB EGYPT', 'QNBAlahli', 'QNB Alahli'], text: ['qnb'] },
  { key: 'hsbc', label: 'HSBC', senders: ['HSBC', 'HSBC Egypt', 'HSBCEG'], text: ['hsbc'] },
  { key: 'aaib', label: 'AAIB', senders: ['AAIB', 'Arab African', 'ArabAfrican'], text: ['aaib', 'arab african international', 'العربي الافريقي'] },
  { key: 'baraka', label: 'بنك البركة', senders: ['Al Baraka', 'Baraka Bank', 'AlBaraka', 'Baraka'], text: ['al baraka', 'بنك البركه', 'البركه'] },
  { key: 'fab', label: 'بنك أبوظبي الأول مصر (FAB)', senders: ['FAB', 'FAB Misr', 'FABMisr', 'First Abu Dhabi'], text: ['fab misr', 'first abu dhabi', 'ابوظبي الاول'] },
  { key: 'adib', label: 'ADIB مصر', senders: ['ADIB', 'ADIB Egypt'], text: ['adib', 'abu dhabi islamic'] },
  { key: 'crediagricole', label: 'كريدي أجريكول مصر', senders: ['CAE', 'Credit Agricole', 'CreditAgricole', 'CA Egypt'], text: ['credit agricole', 'كريدي اجريكول'] },
  { key: 'faisal', label: 'بنك فيصل الإسلامي', senders: ['Faisal Bank', 'FaisalBank', 'Faisal Islamic', 'FIB'], text: ['faisal islamic', 'فيصل الاسلامي', 'بنك فيصل'] },
  { key: 'mashreq', label: 'مشرق مصر', senders: ['Mashreq', 'Mashreq Egypt'], text: ['mashreq', 'مشرق'] },
  { key: 'egyptian_gulf', label: 'بنك المصرف المتحد', senders: ['United Bank', 'UB', 'UBE', 'UBank'], text: ['united bank', 'المصرف المتحد'] },
  { key: 'alex_bank', label: 'بنك الإسكندرية', senders: ['Alex Bank', 'AlexBank', 'Bank of Alexandria', 'ALEXBANK'], text: ['alexbank', 'alex bank', 'بنك الاسكندريه'] },
  { key: 'banque_du_caire', label: 'بنك القاهرة', senders: ['Banque du Caire', 'BDC', 'Cairo Bank', 'BanqueDuCaire'], text: ['banque du caire', 'بنك القاهره'] },
  { key: 'hdb', label: 'بنك التعمير والإسكان', senders: ['HDB', 'HDBank', 'Housing Bank', 'HD Bank'], text: ['housing and development', 'التعمير والاسكان'] },
  { key: 'egb', label: 'البنك المصري الخليجي', senders: ['EGB', 'Egyptian Gulf Bank', 'EGBank'], text: ['egyptian gulf bank', 'المصري الخليجي'] },
  { key: 'scbank', label: 'بنك قناة السويس', senders: ['SCB', 'Suez Canal Bank', 'SuezCanalBank'], text: ['suez canal bank', 'قناه السويس'] },
  { key: 'saib', label: 'SAIB', senders: ['SAIB', 'Societe Arabe'], text: ['saib', 'العربيه الدوليه للبنوك'] },
  { key: 'blom', label: 'بلوم مصر', senders: ['Blom', 'BLOM Egypt', 'BLOM Bank'], text: ['blom'] },
  { key: 'abk', label: 'البنك الأهلي الكويتي - مصر', senders: ['ABK', 'ABK Egypt', 'Ahli Bank Kuwait'], text: ['ahli bank of kuwait', 'الاهلي الكويتي'] },
  { key: 'enbd', label: 'الإمارات دبي الوطني مصر', senders: ['ENBD', 'Emirates NBD', 'EmiratesNBD', 'ENBD Egypt'], text: ['emirates nbd', 'الامارات دبي الوطني'] },
  { key: 'arab_bank', label: 'البنك العربي', senders: ['Arab Bank', 'ArabBank'], text: ['arab bank', 'البنك العربي'] },
  { key: 'midbank', label: 'MIDBANK', senders: ['MIDBANK', 'Mid Bank', 'Misr Iran'], text: ['midbank', 'مصر ايران'] },
  { key: 'nsb', label: 'بنك ناصر الاجتماعي', senders: ['NSB', 'Nasser Bank', 'Nasser Social'], text: ['nasser social', 'ناصر الاجتماعي'] },
  { key: 'agri_bank', label: 'البنك الزراعي المصري', senders: ['ABE', 'Agricultural Bank', 'AgriBank'], text: ['agricultural bank of egypt', 'البنك الزراعي'] },
  { key: 'aibank', label: 'البنك العربي للاستثمار (aiBANK)', senders: ['aiBANK', 'AI Bank', 'AIBank'], text: ['aibank'] },
  { key: 'ebe', label: 'بنك تنمية الصادرات', senders: ['EBE', 'Export Development', 'EDB'], text: ['export development bank', 'تنميه الصادرات'] },
  { key: 'idb', label: 'بنك التنمية الصناعية', senders: ['IDB', 'Industrial Development Bank'], text: ['industrial development bank', 'التنميه الصناعيه'] },
  { key: 'attijariwafa', label: 'التجاري وفا بنك', senders: ['Attijariwafa', 'Attijari', 'CWB', 'Attijariwafa Egypt'], text: ['attijariwafa', 'التجاري وفا'] },
  { key: 'bank_nxt', label: 'Bank NXT', senders: ['Bank NXT', 'BankNXT', 'NXT'], text: ['bank nxt'] },
  { key: 'meeza', label: 'ميزة', senders: ['Meeza', 'Meeza Digital'], text: ['meeza', 'ميزه'] },
  { key: 'telda', label: 'Telda', senders: ['Telda'], text: ['telda', 'تيلدا'] },
  { key: 'valu', label: 'valU', senders: ['VALU', 'valU'], text: ['valu'] },
  { key: 'contact', label: 'كونتاكت', senders: ['Contact', 'Contact Financial', 'Contact Cars'], text: ['contact financial', 'كونتاكت'] },
  { key: 'halan', label: 'MNT-Halan', senders: ['Halan', 'MNT-Halan', 'MNT Halan', 'Tasaheel'], text: ['halan', 'حالا'] },

  // ============ محافظ إلكترونية وتحويلات فورية ============
  { key: 'vodafone_cash', label: 'فودافون كاش', senders: ['Vodafone Cash', 'VFCash', 'VF-Cash', 'VF Cash', 'VodafoneCash', 'Vodacash', 'Vodafone', 'Ana Vodafone', 'AnaVodafone', 'VF'], text: ['vodafone cash', 'vf cash', 'vf-cash', 'فودافون كاش', 'فودافون'] },
  { key: 'etisalat_cash', label: 'اتصالات كاش (e& money)', senders: ['Etisalat Cash', 'EtisalatCash', 'Etisalat', 'e& money', 'e&money', 'e&', 'Etisalat Misr', 'Etisalat by e&'], text: ['etisalat cash', 'e& money', 'اتصالات كاش', 'اتصالات'] },
  { key: 'orange_cash', label: 'أورنج كاش', senders: ['Orange Cash', 'OrangeCash', 'Orange Money', 'Orange', 'Orange EG', 'OrangeEG'], text: ['orange cash', 'orange money', 'اورنج كاش', 'اورانج كاش', 'اورنج'] },
  { key: 'we_pay', label: 'WE Pay', senders: ['WE Pay', 'WEPay', 'WE-Pay', 'WE Cash', 'Telecom Egypt', 'TE'], text: ['we pay', 'wepay', 'we cash', 'دبليو اي باي'] },
  { key: 'instapay', label: 'إنستاباي', senders: ['InstaPay', 'Insta Pay', 'INSTAPAY', 'IPN', 'InstaPay EG'], text: ['instapay', 'insta pay', 'انستاباي', 'انستا باي'] },
  { key: 'fawry', label: 'فوري', senders: ['Fawry', 'FawryPay', 'Fawry Pay', 'Fawry Plus'], text: ['fawry', 'فوري'] },
  { key: 'paymob', label: 'Paymob', senders: ['Paymob', 'Accept'], text: ['paymob'] },
  { key: 'aman', label: 'أمان', senders: ['Aman', 'Aman Holding', 'Aman Cash'], text: ['aman holding', 'شركه امان'] },
  { key: 'mobicash', label: 'موبي كاش', senders: ['MobiCash', 'Mobi Cash'], text: ['mobicash', 'موبي كاش'] },
  { key: 'sympl', label: 'Sympl', senders: ['Sympl'], text: ['sympl'] },
];

export const GENERIC_BANK = { key: 'other_bank', label: 'بنك / محفظة', senders: [], text: [] };

export function flattenSenderList() {
  return EGYPT_BANK_WALLET_SENDERS.flatMap((entry) => entry.senders);
}

// تطبيع اسم المرسل: أحرف صغيرة + إزالة أي شيء غير حرف/رقم (مسافات، شرطات، رموز)، مع الإبقاء على العربي.
function squash(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff&]+/g, '');
}

// مطابقة اسم المرسل الوارد فعليًا في رسالة الـ SMS:
//  - تطابق تام بعد التطبيع دايمًا مقبول.
//  - الأسماء القصيرة (3 حروف أو أقل، زي WE/BM/TE/UB/CIB) مقبولة بالتطابق التام بس، عشان "WE" ما تلقطش أي مرسل فيه حرفين we.
//  - الأسماء الأطول مقبولة كتطابق جزئي (بعض الشبكات بتضيف بادئة/لاحقة، زي "CIB-EGY" أو "AD-NBE").
export function matchBankSender(rawSender) {
  const normalized = squash(rawSender);
  if (!normalized) return null;
  let partial = null;
  for (const entry of EGYPT_BANK_WALLET_SENDERS) {
    for (const sender of entry.senders) {
      const s = squash(sender);
      if (!s) continue;
      if (normalized === s) return entry;
      if (partial) continue;
      if (s.length >= 4) {
        if (normalized.length >= 4 && (normalized.includes(s) || s.includes(normalized))) partial = entry;
      } else if (s.length === 3) {
        // اختصار من 3 حروف (CIB/NBE/HDB): نقبله لو الاسم بيبدأ بيه وقصير (زي CIBEGY)، مش لو جزء من كلمة طويلة.
        if (normalized.length <= 8 && normalized.startsWith(s)) partial = entry;
      }
    }
  }
  return partial;
}

// لو المرسل مش معروف: نحاول نعرف الجهة من اسمها المكتوب في نص الرسالة نفسه.
export function detectBankFromText(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
  for (const entry of EGYPT_BANK_WALLET_SENDERS) {
    for (const needle of entry.text || []) {
      if (!needle) continue;
      // الأسماء اللاتينية القصيرة نطابقها ككلمة كاملة، والباقي كجزء من النص
      const isLatinShort = /^[a-z0-9& ]+$/.test(needle) && needle.length <= 5;
      const found = isLatinShort ? new RegExp(`(?<![a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(t) : t.includes(needle);
      if (found) return entry;
    }
  }
  return null;
}

// رقم موبايل أو اسم مرسل أرقام فقط (مش اسم جهة): ده غالبًا شخص عادي، مش بنك.
export function looksLikePersonalNumber(rawSender) {
  const s = String(rawSender || '').trim();
  return /^\+?\d[\d\s-]{6,}$/.test(s);
}
