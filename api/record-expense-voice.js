import { supabase } from '../lib/supabaseClient.js';
import { transcribeAudioBuffer, classifyMessage } from '../lib/groq.js';
import { insertExpenseAndGetTodayTotal } from '../lib/expenses.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { getChatIdByUserId, hasActiveSubscription, isInTrial } from '../lib/users.js';
import { CATEGORY_EMOJI, CATEGORIES } from '../lib/config.js';

// ============ POST /api/record-expense-voice ============
// بتتنادى من زرار "سجّل مصروفك" في تاب "يومي" بالداشبورد.
// بتاخد الصوت اللي المستخدم سجّله من المتصفح، تفرّغه وتصنّفه بنفس منطق بوت تليجرام
// بالظبط (lib/groq.js)، وتسجّل المصروف في نفس جدول expenses (lib/expenses.js).
//
// Body: { audioBase64: "data:audio/webm;base64,...." }
// Header: Authorization: Bearer <supabase access token بتاع الجلسة الحالية>
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8MB كفاية جدًا لتسجيل صوتي لمدة قليلة من الثواني

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ---- المصادقة: نفس نمط dashboard-data.js و subscription-proof.js ----
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (!link) {
      return res.status(400).json({ error: 'لازم تربط حسابك بتليجرام الأول (من تاب حسابي).' });
    }
    const telegramUserId = link.telegram_user_id;

    // ---- البوابة: مسموح يسجّل بس لو اشتراكه فعّال أو لسه في الـ 3 أيام تجربة مجانية ----
    // (نفس المنطق بالظبط بتاع بوت تليجرام في telegram-webhook.js)
    const subscribed = await hasActiveSubscription(telegramUserId);
    if (!subscribed) {
      const inTrial = await isInTrial(telegramUserId);
      if (!inTrial) {
        return res.status(200).json({ ok: false, reason: 'trial_ended' });
      }
    }

    // ---- المصدر: تسجيل صوتي، أو إدخال يدوي مباشر من نفس الشيت ----
    const audioBase64 = String(req.body?.audioBase64 || '');
    let text = '';
    let expenseTx = null;

    if (audioBase64) {
      // ملحوظة: متصفحات زي Chrome على أندرويد بتسجل الصوت بصيغة فيها باراميترات زيادة
      // بعد نوع الملف، زي "audio/webm;codecs=opus" بدل "audio/webm" بس. الـ regex هنا
      // لازم يتقبل أي باراميترات زيادة قبل "base64," مش يفترض إنها مش موجودة.
      const match = audioBase64.match(/^data:audio\/[a-zA-Z0-9.+-]+(?:;[^,]+)*;base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'ملف صوتي غير صالح، جرب تاني.' });
      }
      const buffer = Buffer.from(match[1], 'base64');
      if (buffer.byteLength === 0) {
        return res.status(400).json({ error: 'مسجّلتش أي صوت، جرب تاني.' });
      }
      if (buffer.byteLength > MAX_AUDIO_BYTES) {
        return res.status(400).json({ error: 'التسجيل طويل أوي، جرب تسجيل أقصر.' });
      }

      // ---- تفريغ الصوت لنص عبر Groq Whisper (نفس الدالة اللي بيستخدمها بوت تليجرام) ----
      text = (await transcribeAudioBuffer(buffer, 'expense.webm')).trim();
      if (!text) {
        return res.status(200).json({ ok: false, reason: 'unclear', heardText: '' });
      }

      // ---- تصنيف الكلام (نفس دالة البوت بالظبط) ----
      const transactions = await classifyMessage(text);
      expenseTx = (transactions || []).find(
        (t) => t.type === 'expense' && Number(t.amount) > 0 && CATEGORIES.includes(t.category)
      );

      if (!expenseTx) {
        // مش واضح / مش مصروف — بنرجّع النص اللي سمعناه عشان الواجهة تعرض حالة "كلام غير واضح"
        return res.status(200).json({ ok: false, reason: 'unclear', heardText: text });
      }
    } else {
      // ---- إدخال يدوي (لما المستخدم يختار "اكتبه بإيدك" في نفس الشيت) ----
      const amount = Number(req.body?.amount);
      const category = String(req.body?.category || 'أخرى');
      const note = String(req.body?.note || '').trim().slice(0, 200);
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'المبلغ لازم يكون رقم أكبر من صفر.' });
      }
      expenseTx = { amount, category: CATEGORIES.includes(category) ? category : 'أخرى', note };
      text = note || 'إدخال يدوي من الداشبورد';
    }

    // ---- تسجيل المصروف فعليًا في نفس جدول expenses ----
    const todayTotal = await insertExpenseAndGetTodayTotal(expenseTx, text, telegramUserId);

    // ---- تأكيد على تليجرام كمان، لو المستخدم عنده chat_id (نفس تجربة البوت، من مكان تاني) ----
    const chatId = await getChatIdByUserId(telegramUserId);
    if (chatId) {
      const detail = expenseTx.note && expenseTx.note.trim() && expenseTx.note.trim() !== expenseTx.category
        ? ` (${expenseTx.note.trim()})`
        : '';
      sendTelegramMessage(
        chatId,
        `✅ <b>تمام، سجلت المصروف</b> (من الداشبورد)\n${CATEGORY_EMOJI[expenseTx.category] || '📌'} ${expenseTx.category}${detail} · ${expenseTx.amount} جنيه\n\n💰 إجمالي صرفك النهاردة: <b>${todayTotal} جنيه</b>`,
        'HTML'
      ).catch((e) => console.error('record-expense-voice: telegram notify failed', e));
    }

    return res.status(200).json({
      ok: true,
      heardText: text,
      expense: {
        amount: Number(expenseTx.amount),
        category: expenseTx.category,
        emoji: CATEGORY_EMOJI[expenseTx.category] || '📌',
        note: expenseTx.note || '',
      },
      todayTotal,
    });
  } catch (err) {
    console.error('record-expense-voice error:', err);
    return res.status(500).json({ error: 'حصل خطأ في تسجيل المصروف، جرب تاني.' });
  }
}
