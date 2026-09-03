// backend/api-handlers/bank-statement-import.js
// رفع كشف حساب بنكي (PDF نصي) — بيتستخدم من تبويب "حسابي" في الداشبورد.
//
// المرحلة الأولى: PDF نصي فقط (أغلب البنوك المصرية بتصدّره كده من التطبيق مباشرة).
// كشف حساب ممسوح ضوئيًا (سكانر) هيترفض حاليًا برسالة واضحة، مش هيتقرا غلط بصمت —
// ده تحسين مستقبلي منفصل (OCR) لأنه أغلى بكتير من النص العادي.
//
// خطوات المعالجة:
// 1) استخراج النص من الـ PDF محليًا (pdf-parse) — مجاني تمامًا، مفيش أي API خارجي هنا.
// 2) تقسيم النص لسطور، وتقسيم السطور لدفعات صغيرة (BANK_STATEMENT_LINES_PER_AI_CALL سطر لكل دفعة)
//    زي بالظبط نظام استيراد الـ CSV الموجود، عشان التكلفة تتحكم فيها وميحصلش timeout.
// 3) كل دفعة بتتبعت لـ extractTransactionsFromRows (نفس الدالة المستخدمة في استيراد البيانات العادي).
// 4) قبل التسجيل: فحص تكرار مزدوج —
//    أ) import_key (زي نظام الاستيراد العادي) يمنع تكرار نفس الملف لو اترفع تاني بالغلط.
//    ب) مطابقة تقريبية (نفس المبلغ + تاريخ قريب) مع مصاريف موجودة بالفعل (SMS/يدوي) — عشان لو
//       العميل مفعّل SMS webhook أصلاً، مايتسجلش نفس العملية مرتين من مصدرين مختلفين.

import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { extractTransactionsFromRows } from '../../lib/groq.js';
import { checkStatementUsage, refundStatementUsage } from '../../lib/rateLimits.js';
import { BANK_STATEMENT_MAX_PDF_PAGES, BANK_STATEMENT_MAX_LINES, BANK_STATEMENT_LINES_PER_AI_CALL } from '../../lib/config.js';
import crypto from 'crypto';

function importKeyFor(userId, t) {
  const raw = `${userId}|${t.date || ''}|${Number(t.amount)}|${t.category || ''}|${(t.note || '').trim()}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ============ فحص تكرار تقريبي مع مصاريف موجودة بالفعل (من SMS أو إدخال يدوي) ============
// بنعتبر العملية "موجودة بالفعل" لو نفس المبلغ بالظبط وفي نطاق يوم واحد فرق (كشف الحساب أحيانًا
// بيسجل تاريخ التقاص مش تاريخ العملية نفسها، فيوم فرق كفاية يغطي الفروق الشائعة دي).
async function isLikelyDuplicate(userId, t) {
  if (!t.date) return false; // من غير تاريخ مينفعش نطابق بثقة، نسيبها تتسجل عادي
  const day = new Date(t.date);
  if (Number.isNaN(day.getTime())) return false;
  const from = new Date(day); from.setDate(from.getDate() - 1);
  const to = new Date(day); to.setDate(to.getDate() + 2);

  const { data, error } = await supabase
    .from('expenses')
    .select('id')
    .eq('telegram_user_id', userId)
    .eq('amount', Number(t.amount))
    .gte('created_at', from.toISOString())
    .lt('created_at', to.toISOString())
    .limit(1);
  if (error) { console.error('bank-statement dedup check error:', JSON.stringify(error)); return false; }
  return Boolean(data && data.length);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });
  const { dataUserId } = dashboardUser;

  const { fileBase64, fileName = '', mimeType = 'application/pdf' } = req.body || {};
  const cleanBase64 = String(fileBase64 || '').replace(/^data:[^,]+,/, '');
  if (!cleanBase64) return res.status(400).json({ ok: false, error: 'الملف فاضي.' });
  if (!/pdf/i.test(mimeType)) {
    return res.status(400).json({ ok: false, error: 'دلوقتي بندعم كشوف الحساب اللي بصيغة PDF بس (المصدّرة مباشرة من تطبيق البنك). دعم الصور جاي قريبًا.' });
  }

  const usage = await checkStatementUsage(dataUserId);
  if (!usage.allowed) {
    if (usage.isTrial) {
      return res.status(403).json({ ok: false, error: 'خلصت حدود رفع كشوف الحساب في التجربة المجانية. اشترك عشان تكمل.', trialEnded: true });
    }
    return res.status(429).json({ ok: false, error: 'وصلت للحد الأقصى من كشوف الحساب الشهر ده. هيرجع تاني بداية الشهر الجاي.', limitReached: true });
  }

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
  } catch {
    await refundStatementUsage(dataUserId);
    return res.status(400).json({ ok: false, error: 'الملف تالف أو مش قادر أقراه.' });
  }
  // ملحوظة: فيرسل بيحدد حجم الـ request body لأي serverless function بـ 4.5 ميجا كحد أقصى (مش قابل للتعديل)،
  // وترميز base64 بيزوّد حجم الملف حوالي 33%. فبنحط سقف أصغر هنا (3 ميجا للملف الأصلي) عشان الطلب
  // مايترفضش من فيرسل نفسه بعد ما المستخدم يكون استنى الرفع.
  if (buffer.length > 3 * 1024 * 1024) {
    await refundStatementUsage(dataUserId);
    return res.status(400).json({ ok: false, error: 'حجم الملف كبير أوي (أقصى حد 3 ميجا). جرب تصدّر فترة أقصر (شهر واحد بدل كذا شهر).' });
  }

  let pdfData;
  try {
    const pdfParse = (await import('pdf-parse')).default;
    pdfData = await pdfParse(buffer);
  } catch (err) {
    console.error('bank-statement PDF parse error:', err);
    await refundStatementUsage(dataUserId);
    return res.status(422).json({ ok: false, error: 'معرفتش أفتح الملف. تأكد إنه PDF سليم ومش محمي بباسورد.' });
  }

  if (pdfData.numpages > BANK_STATEMENT_MAX_PDF_PAGES) {
    await refundStatementUsage(dataUserId);
    return res.status(422).json({ ok: false, error: `الكشف طويل أوي (${pdfData.numpages} صفحة). حاليًا بندعم لحد ${BANK_STATEMENT_MAX_PDF_PAGES} صفحة — جرب ترفع فترة أقصر (شهر واحد مثلاً).` });
  }

  const text = String(pdfData.text || '').trim();
  // كشف حساب ممسوح ضوئيًا (سكانر) بيطلع نص فاضي أو شبه فاضي من pdf-parse — بنرفضه بوضوح
  // بدل ما نبعت نص فاضي لـ AI ونسجل صفر عمليات من غير ما نفهم ليه.
  if (text.length < 40) {
    await refundStatementUsage(dataUserId);
    return res.status(422).json({ ok: false, error: 'الملف ده شكله صورة ممسوحة ضوئيًا مش PDF نصي، فمعرفتش أقراه. جرب تصدّر الكشف تاني كـ"PDF" مباشرة من تطبيق البنك بدل ما تسكنه.' });
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, BANK_STATEMENT_MAX_LINES);

  const { data: job, error: jobError } = await supabase
    .from('import_jobs')
    .insert({
      telegram_user_id: dataUserId,
      file_name: String(fileName).slice(0, 255),
      source_app: 'كشف حساب بنكي',
      total_rows: lines.length,
      status: 'processing',
    })
    .select('*')
    .single();
  if (jobError) {
    console.error('bank-statement job create error:', JSON.stringify(jobError));
    await refundStatementUsage(dataUserId);
    return res.status(500).json({ ok: false, error: 'تعذر بدء الاستيراد.' });
  }

  let insertedCount = 0;
  let skippedCount = 0;
  let duplicateCount = 0;

  for (let i = 0; i < lines.length; i += BANK_STATEMENT_LINES_PER_AI_CALL) {
    const chunkLines = lines.slice(i, i + BANK_STATEMENT_LINES_PER_AI_CALL);
    const rowsText = chunkLines.join('\n').slice(0, 12000);
    const transactions = await extractTransactionsFromRows(rowsText, { sourceApp: 'كشف حساب بنكي' });

    for (const t of transactions) {
      const amount = Number(t.amount);
      if (!Number.isFinite(amount) || amount <= 0) { skippedCount += 1; continue; }

      if (await isLikelyDuplicate(dataUserId, t)) { duplicateCount += 1; continue; }

      const currency_code = String(t.currency_code || 'EGP').trim().toUpperCase().slice(0, 3) || 'EGP';
      const category = t.category || 'مصروف عام';
      const import_key = importKeyFor(dataUserId, t);
      const created_at = t.date ? new Date(t.date) : new Date();
      const row = {
        telegram_user_id: dataUserId,
        amount,
        currency_code,
        category,
        description: t.note || '',
        created_at: Number.isNaN(created_at.getTime()) ? new Date().toISOString() : created_at.toISOString(),
        import_source: 'كشف حساب بنكي',
        import_key,
      };
      const { error: insertError } = await supabase.from('expenses').insert(row);
      if (insertError) {
        if (insertError.code === '23505') { skippedCount += 1; } // نفس الصف اتسجل قبل كده من نفس الملف
        else console.error('bank-statement insert row error:', JSON.stringify(insertError));
      } else {
        insertedCount += 1;
      }
    }
  }

  const { error: updateError } = await supabase
    .from('import_jobs')
    .update({ processed_rows: lines.length, inserted_rows: insertedCount, skipped_rows: skippedCount + duplicateCount, status: 'done', updated_at: new Date().toISOString() })
    .eq('id', job.id);
  if (updateError) console.error('bank-statement job update error:', JSON.stringify(updateError));

  return res.status(200).json({
    ok: true,
    jobId: job.id,
    insertedCount,
    skippedCount,
    duplicateCount,
    message: duplicateCount > 0
      ? `تم تسجيل ${insertedCount} عملية جديدة، واتجاهلنا ${duplicateCount} عملية كانت متسجلة عندك بالفعل (زي رسايل البنك مثلاً).`
      : `تم تسجيل ${insertedCount} عملية من كشف الحساب.`,
    usage: !usage.isTrial && usage.remaining !== null ? { remaining: usage.remaining, limit: usage.limit } : null,
  });
}
