import { supabase } from '../lib/supabaseClient.js';
import { transcribeAudioBuffer, classifyMessage } from '../lib/groq.js';
import { insertExpense, getTodayExpensesTotal } from '../lib/expenses.js';
import { insertDebt, insertDebtSettlement } from '../lib/debts.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { getChatIdByUserId, hasActiveSubscription, isInTrial } from '../lib/users.js';
import { CATEGORY_EMOJI, CATEGORIES } from '../lib/config.js';

// ============ POST /api/record-expense-voice ============
// بتتنادى من زرار "سجّل مصروفك" في تاب "يومي" بالداشبورد.
// بتاخد الصوت اللي المستخدم سجّله من المتصفح، تفرّغه وتصنّفه بنفس منطق بوت تليجرام
// بالظبط (lib/groq.js). الفويس ممكن يكون فيه أكتر من عملية مرة واحدة (زي "٥٠ غدا و١٠٠
// تاكسي" أو "دفعت ٢٠٠ سوبر ماركت وواصل من أحمد ٥٠٠") — بنسجّلهم كلهم مرة واحدة: مصاريف،
// ديون/سلف، وتسويات حسابات، كل واحدة في الجدول بتاعها.
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
    // كل العناصر اللي هنسجّلها فعليًا في الآخر (مصاريف/ديون/تسويات)، كل واحد بشكل موحّد
    // { kind: 'expense'|'debt'|'settlement', ... } عشان الفرونت إند يعرضهم كلهم مرة واحدة.
    let items = [];

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

      // ---- تصنيف الكلام: ممكن يرجع أكتر من معاملة مرة واحدة (نفس دالة البوت بالظبط) ----
      const transactions = await classifyMessage(text);

      for (const t of transactions || []) {
        if (t.type === 'expense' && Number(t.amount) > 0 && CATEGORIES.includes(t.category)) {
          items.push({ kind: 'expense', amount: Number(t.amount), category: t.category, note: t.note || '' });
        } else if (t.type === 'debt' && t.person && Number(t.amount) > 0) {
          items.push({
            kind: 'debt',
            person: String(t.person).trim(),
            amount: Number(t.amount),
            direction: t.direction === 'borrowed' ? 'borrowed' : 'lent',
            isRepayment: Boolean(t.is_repayment),
            note: t.note || '',
          });
        } else if (t.type === 'settlement' && t.person) {
          items.push({ kind: 'settlement', person: String(t.person).trim() });
        }
        // أي نوع تاني (unknown أو بيانات ناقصة) بيتجاهل، زي منطق البوت بالظبط.
      }

      if (items.length === 0) {
        // مفيش ولا عملية واحدة واضحة في كل اللي اتقال — بنرجّع النص اللي سمعناه عشان
        // الواجهة تعرض حالة "كلام غير واضح"
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
      items = [{ kind: 'expense', amount, category: CATEGORIES.includes(category) ? category : 'أخرى', note }];
      text = note || 'إدخال يدوي من الداشبورد';
    }

    // ---- نسجّل كل العناصر فعليًا، كل واحد في الجدول بتاعه ----
    const savedItems = [];
    let hasExpense = false;

    for (const item of items) {
      if (item.kind === 'expense') {
        await insertExpense(item, item.note || text, telegramUserId);
        hasExpense = true;
        savedItems.push({
          kind: 'expense',
          amount: item.amount,
          category: item.category,
          emoji: CATEGORY_EMOJI[item.category] || '📌',
          note: item.note || '',
        });
      } else if (item.kind === 'debt') {
        const result = await insertDebt(
          { person: item.person, amount: item.amount, direction: item.direction, is_repayment: item.isRepayment, note: item.note },
          telegramUserId
        );
        if (result.ok) {
          savedItems.push({
            kind: 'debt',
            person: item.person,
            amount: item.amount,
            isLent: result.isLent,
            isRepayment: result.isRepayment,
          });
        }
      } else if (item.kind === 'settlement') {
        const result = await insertDebtSettlement(item.person, telegramUserId);
        savedItems.push({ kind: 'settlement', person: item.person, ok: result.ok, reason: result.reason || null });
      }
    }

    if (savedItems.length === 0) {
      return res.status(200).json({ ok: false, reason: 'unclear', heardText: text });
    }

    // ---- إجمالي مصروفات النهاردة (لو فيه مصروف واحد على الأقل من ضمن اللي اتسجّل) ----
    const todayTotal = hasExpense ? await getTodayExpensesTotal(telegramUserId) : null;

    // ---- تأكيد واحد على تليجرام يلخّص كل العمليات اللي اتسجّلت، لو المستخدم عنده chat_id ----
    const chatId = await getChatIdByUserId(telegramUserId);
    if (chatId) {
      const lines = savedItems.map((it) => {
        if (it.kind === 'expense') {
          const detail = it.note && it.note.trim() && it.note.trim() !== it.category ? ` (${it.note.trim()})` : '';
          return `${it.emoji} ${it.category}${detail} · ${it.amount} جنيه`;
        }
        if (it.kind === 'debt') {
          if (it.isRepayment) {
            return it.isLent
              ? `↩️ رجّعت لـ ${it.person} ${it.amount} جنيه`
              : `↩️ ${it.person} رجّعلك ${it.amount} جنيه`;
          }
          return it.isLent
            ? `📤 بقى ليك عند ${it.person} ${it.amount} جنيه`
            : `📥 بقى عليك لـ ${it.person} ${it.amount} جنيه`;
        }
        if (it.kind === 'settlement') {
          return it.ok ? `✅ اتسوى الحساب مع ${it.person}` : `⚠️ معنديش ديون مسجلة مع ${it.person}`;
        }
        return '';
      });

      const summaryHeader = savedItems.length > 1
        ? `✅ <b>تمام، سجلت ${savedItems.length} عمليات</b> (من الداشبورد)`
        : '✅ <b>تمام، سجلت العملية</b> (من الداشبورد)';

      const totalLine = todayTotal !== null ? `\n\n💰 إجمالي صرفك النهاردة: <b>${todayTotal} جنيه</b>` : '';

      sendTelegramMessage(chatId, `${summaryHeader}\n${lines.join('\n')}${totalLine}`, 'HTML').catch((e) =>
        console.error('record-expense-voice: telegram notify failed', e)
      );
    }

    return res.status(200).json({
      ok: true,
      heardText: text,
      items: savedItems,
      todayTotal,
    });
  } catch (err) {
    console.error('record-expense-voice error:', err);
    return res.status(500).json({ error: 'حصل خطأ في تسجيل المصروف، جرب تاني.' });
  }
}
