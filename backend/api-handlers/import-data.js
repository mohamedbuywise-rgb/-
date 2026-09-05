// backend/api-handlers/import-data.js
// استيراد بيانات من تطبيق تاني — بيتستخدم من تبويب "حسابي" في الداشبورد.
//
// المستخدم برفع ملف (CSV/Excel اتحول CSV من المتصفح/أو نص خام)، والفرونت إند بيقسّمه
// دفعات صغيرة (batches) ويبعتهم واحدة واحدة للـ endpoint ده. كل دفعة بتتبعت لـ AI عشان
// تتحول لمعاملات موحّدة، وبعدين بتتسجل في expenses بمفتاح تكرار (import_key) عشان لو
// نفس الدفعة اتبعتت تاني (قطع نت / إعادة تحميل الصفحة) ميتكررش أي صف.
//
// POST action=start  body: { fileName, sourceApp, totalRows } -> بينشئ import_jobs صف، يرجّع jobId
// POST action=chunk   body: { jobId, rows: string[] }         -> بيبعت الدفعة لل AI ويسجلها، يرجّع تقدّم محدث
// GET  ?jobId=...                                              -> بيرجّع حالة آخر job (استئناف بعد إغلاق الصفحة)

import { supabase } from '../../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { extractTransactionsFromRows } from '../../lib/groq.js';
import crypto from 'crypto';

function importKeyFor(userId, t) {
  const raw = `${userId}|${t.date || ''}|${Number(t.amount)}|${t.category || ''}|${(t.note || '').trim()}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

export default async function handler(req, res) {
  const dashboardUser = await getDashboardUserFromRequest(req);
  if (!dashboardUser) return res.status(401).json({ ok: false, error: 'محتاج تسجيل دخول.' });
  const { dataUserId } = dashboardUser;

  if (req.method === 'GET') {
    const jobId = String(req.query?.jobId || '');
    if (!jobId) {
      // آخر job لسه شغال (لو فيه) عشان الواجهة تعرض "استكمال الاستيراد اللي بدأته"
      const { data } = await supabase
        .from('import_jobs')
        .select('*')
        .eq('telegram_user_id', dataUserId)
        .neq('status', 'done')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return res.status(200).json({ ok: true, job: data || null });
    }
    const { data, error } = await supabase.from('import_jobs').select('*').eq('id', jobId).eq('telegram_user_id', dataUserId).maybeSingle();
    if (error || !data) return res.status(404).json({ ok: false, error: 'الاستيراد ده مش موجود.' });
    return res.status(200).json({ ok: true, job: data });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const action = String(req.query?.action || req.body?.action || '');

  if (action === 'start') {
    const { fileName = '', sourceApp = '', totalRows = 0 } = req.body || {};
    const { data, error } = await supabase
      .from('import_jobs')
      .insert({
        telegram_user_id: dataUserId,
        file_name: String(fileName).slice(0, 255),
        source_app: String(sourceApp).slice(0, 100),
        total_rows: Math.max(0, Number(totalRows) || 0),
        status: 'processing',
      })
      .select('*')
      .single();
    if (error) {
      console.error('import-data start error:', JSON.stringify(error));
      return res.status(500).json({ ok: false, error: 'تعذر بدء الاستيراد.' });
    }
    return res.status(200).json({ ok: true, job: data });
  }

  if (action === 'chunk') {
    const { jobId, rows, sourceApp = '' } = req.body || {};
    if (!jobId || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'بيانات الدفعة ناقصة.' });
    }
    const { data: job, error: jobError } = await supabase
      .from('import_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('telegram_user_id', dataUserId)
      .maybeSingle();
    if (jobError || !job) return res.status(404).json({ ok: false, error: 'الاستيراد ده مش موجود.' });

    const rowsText = rows.slice(0, 60).join('\n').slice(0, 12000); // حماية من دفعات ضخمة تكسر الطلب
    const transactions = await extractTransactionsFromRows(rowsText, { sourceApp });

    let insertedCount = 0;
    let skippedCount = 0;
    for (const t of transactions) {
      const amount = Number(t.amount);
      if (!Number.isFinite(amount) || amount <= 0) { skippedCount += 1; continue; }
      const currency_code = String(t.currency_code || 'EGP').trim().toUpperCase().slice(0, 3) || 'EGP';
      const category = t.category || 'تسوق';
      const import_key = importKeyFor(dataUserId, t);
      const created_at = t.date ? new Date(t.date) : new Date();
      const row = {
        telegram_user_id: dataUserId,
        amount,
        currency_code,
        category,
        description: t.note || '',
        created_at: Number.isNaN(created_at.getTime()) ? new Date().toISOString() : created_at.toISOString(),
        import_source: sourceApp || null,
        import_key,
      };
      // لو نفس import_key موجود قبل كده لنفس المستخدم، الإدراج بيتجاهل (مش يفشل) بفضل
      // الـ unique index الجزئي — كده تكرار نفس الدفعة (أو نفس الملف تاني) آمن تمامًا.
      const { error: insertError } = await supabase.from('expenses').insert(row);
      if (insertError) {
        if (insertError.code === '23505') { skippedCount += 1; } // unique violation = مستورد قبل كده
        else console.error('import-data insert row error:', JSON.stringify(insertError));
      } else {
        insertedCount += 1;
      }
    }

    const processed_rows = Math.min(job.total_rows || rows.length, job.processed_rows + rows.length);
    const status = processed_rows >= (job.total_rows || processed_rows) ? 'done' : 'processing';
    const { data: updatedJob, error: updateError } = await supabase
      .from('import_jobs')
      .update({
        processed_rows,
        inserted_rows: job.inserted_rows + insertedCount,
        skipped_rows: job.skipped_rows + skippedCount,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .select('*')
      .single();
    if (updateError) console.error('import-data update job error:', JSON.stringify(updateError));

    return res.status(200).json({ ok: true, job: updatedJob || job, insertedInBatch: insertedCount, skippedInBatch: skippedCount });
  }

  return res.status(400).json({ ok: false, error: 'action غير معروف.' });
}
