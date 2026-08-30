// قايمة أسماء/أرقام مرسلي الـ SMS الخاصة بالبنوك والمحافظ الإلكترونية المصرية.
// المصدر: الاسم اللي البنك بيبعت بيه الرسالة (Sender ID) زي ما بيظهر على شاشة المستخدم.
// ملحوظة: البنوك بتضيف/تغيّر الـ Sender ID بين فترة وأخرى، فالقايمة دي محتاجة مراجعة دورية.

export const EGYPT_BANK_WALLET_SENDERS = [
  // بنوك
  { key: 'cib', label: 'CIB', senders: ['CIB', 'CIB EGYPT'] },
  { key: 'nbe', label: 'البنك الأهلي المصري', senders: ['NBE', 'AHLY', 'National Bank'] },
  { key: 'banque_misr', label: 'بنك مصر', senders: ['Banque Misr', 'BM'] },
  { key: 'qnb', label: 'QNB الأهلي', senders: ['QNB', 'QNB ALAHLI'] },
  { key: 'hsbc', label: 'HSBC', senders: ['HSBC'] },
  { key: 'aaib', label: 'AAIB', senders: ['AAIB'] },
  { key: 'baraka', label: 'بنك البركة', senders: ['Al Baraka', 'Baraka Bank'] },
  { key: 'fab', label: 'First Abu Dhabi Bank', senders: ['FAB'] },
  { key: 'adib', label: 'ADIB مصر', senders: ['ADIB'] },
  { key: 'crediagricole', label: 'كريدي أجريكول مصر', senders: ['CAE', 'Credit Agricole'] },
  { key: 'faisal', label: 'بنك فيصل الإسلامي', senders: ['Faisal Bank'] },
  { key: 'mashreq', label: 'مشرق مصر', senders: ['Mashreq'] },
  { key: 'egyptian_gulf', label: 'بنك المصرف المتحد', senders: ['United Bank', 'UB'] },
  // محافظ إلكترونية وتحويلات فورية
  { key: 'vodafone_cash', label: 'فودافون كاش', senders: ['Vodafone Cash', 'VFCash'] },
  { key: 'etisalat_cash', label: 'اتصالات كاش', senders: ['Etisalat Cash'] },
  { key: 'orange_cash', label: 'أورنج كاش', senders: ['Orange Cash', 'Orange Money'] },
  { key: 'we_pay', label: 'WE Pay', senders: ['WE Pay', 'WEPay'] },
  { key: 'instapay', label: 'إنستاباي', senders: ['InstaPay', 'Insta Pay'] },
  { key: 'fawry', label: 'فوري', senders: ['Fawry'] },
];

export function flattenSenderList() {
  return EGYPT_BANK_WALLET_SENDERS.flatMap((entry) => entry.senders);
}

// بيحاول يتعرف على البنك/المحفظة من اسم المرسل الوارد فعليًا في رسالة الـ SMS.
// مطابقة غير حساسة لحالة الأحرف، بس *مش* مطابقة substring حرة في الاتجاهين —
// دي كانت بتخلي أسماء قصيرة زي "BM" أو "UB" أو "CAE" تتطابق مع أي مرسل يحتوي على
// نفس الحروف كجزء من اسم تاني (تهديد أمني: أي حد يعرف الـ webhook token يقدر
// يبعت sender وهمي يتقبل غلط كأنه بنك حقيقي). دلوقتي: تطابق تام، أو إن اسم المرسل
// الوارد يبدأ بيه/ينتهي بيه (بحد أدنى 3 أحرف) عشان نغطي بادئات/لواحق الشبكة
// (زي "AD-CIB" أو "CIB-EG") من غير ما نفتح الباب لمطابقات substring حرة.
export function matchBankSender(rawSender) {
  const normalized = String(rawSender || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const entry of EGYPT_BANK_WALLET_SENDERS) {
    for (const sender of entry.senders) {
      const s = sender.toLowerCase();
      if (s.length < 3) continue; // تجاهل أسماء قصيرة جدًا كإجراء حماية إضافي
      if (
        normalized === s ||
        normalized.startsWith(`${s} `) || normalized.startsWith(`${s}-`) ||
        normalized.endsWith(` ${s}`) || normalized.endsWith(`-${s}`)
      ) {
        return entry;
      }
    }
  }
  return null;
}
