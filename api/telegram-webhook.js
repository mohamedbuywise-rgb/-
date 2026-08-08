import { transcribeVoice, classifyMessage } from '../lib/groq.js';
import { sendTelegramMessage, forwardTelegramMessage } from '../lib/telegram.js';
import { recordExpense, sendMonthlyReport, sendWeeklyReport, sendDataExport, sendExpenseSearch } from '../lib/expenses.js';
import { recordDebt, sendDebtsReport, sendPersonDebtDetail, settleDebtWithPerson } from '../lib/debts.js';
import { upsertUser, hasActiveSubscription, getSubscriptionExpiry, activateSubscription, getChatIdByUserId } from '../lib/users.js';
import { createLinkCode } from '../lib/linking.js';
import { GUIDE_URL, ADMIN_TELEGRAM_ID, SUBSCRIPTION_DAYS, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK, ADMIN_CONTACT_USERNAME } from '../lib/config.js';

// ============ رسالة "محتاج تشترك" — بتتبعت لأي حد الاشتراك بتاعه مش فعّال ============
function buildSubscriptionPrompt(isExpired) {
  const intro = isExpired
    ? '⏳ اشتراكك في فلوسي بوت خلص.'
    : '🔒 محتاج تشترك الأول عشان تستخدم فلوسي بوت.';

  return (
    `${intro}\n\n` +
    `💳 الاشتراك الشهري: <b>${SUBSCRIPTION_PRICE_EGP} ج.م</b>\n` +
    `1) حوّل عن طريق إنستا باي على: <code>${INSTAPAY_LINK}</code>\n` +
    `2) ابعت سكرين شوت التحويل هنا في الشات، أو لـ ${ADMIN_CONTACT_USERNAME}\n\n` +
    `بمجرد ما نتأكد من التحويل، هيتفعّل اشتراكك على طول وترجع تقدر تستخدم البوت عادي.`
  );
}

// ============ أمر الأدمن السرّي لتفعيل اشتراك مستخدم بعد ما يبعت إيصال الدفع ============
// الصيغة: "فعل <telegram_user_id>" أو "فعل <telegram_user_id> <عدد الأيام>"
// بيشتغل بس لو الرسالة جاية من ADMIN_TELEGRAM_ID، أي حد تاني بيتجاهل الأمر ده تمامًا.
async function tryHandleAdminActivation(text, fromUserId, adminChatId) {
  if (!ADMIN_TELEGRAM_ID || fromUserId !== ADMIN_TELEGRAM_ID) return false;

  const match = text.match(/^فعّ?ل\s+(\d+)(?:\s+(\d+))?$/);
  if (!match) return false;

  const targetUserId = Number(match[1]);
  const days = match[2] ? Number(match[2]) : SUBSCRIPTION_DAYS;

  const newExpiry = await activateSubscription(targetUserId, days);
  if (!newExpiry) {
    await sendTelegramMessage(adminChatId, '❌ حصل خطأ، اتأكد إن الـ user id صح.');
    return true;
  }

  const formattedDate = newExpiry.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
  await sendTelegramMessage(adminChatId, `✅ تم تفعيل الاشتراك للمستخدم ${targetUserId} لحد ${formattedDate}.`);

  // نحاول نبلّغ المستخدم نفسه لو عرفنا الـ chat_id بتاعه
  const targetChatId = await getChatIdByUserId(targetUserId);
  if (targetChatId) {
    await sendTelegramMessage(
      targetChatId,
      `🎉 تم تفعيل اشتراكك في فلوسي بوت لحد ${formattedDate}.\nابعتلي فويس أو رسالة زي "صرفت 50 جنيه أكل" وابدأ على طول.`
    );
  }
  return true;
}

// ============ نقطة الدخول - Vercel بينادي الدالة دي لكل ريكوست ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const userId = message.from.id;

    // بنسجل/نحدّث المستخدم مع كل رسالة، عشان الـ cron jobs تعرف تبعتله لوحدها بعدين
    await upsertUser(userId, chatId);

    // --- أمر الأدمن السرّي لتفعيل الاشتراكات — بيتفحص الأول وبيتجاهل تمامًا لو مش من الأدمن ---
    if (message.text) {
      const handledByAdmin = await tryHandleAdminActivation(message.text.trim(), userId, chatId);
      if (handledByAdmin) return res.status(200).json({ ok: true });
    }

    // --- صورة (سكرين شوت تحويل الاشتراك) — بتتحول للأدمن على طول، حتى لو اليوزر لسه مش مشترك ---
    // ده عشان اليوزر يقدر يبعت إيصال الدفع أول ما يشترك، من غير ما يتقفل عليه بالبوابة تحت.
    if (message.photo) {
      if (ADMIN_TELEGRAM_ID && userId !== ADMIN_TELEGRAM_ID) {
        await forwardTelegramMessage(ADMIN_TELEGRAM_ID, chatId, message.message_id);
        await sendTelegramMessage(
          ADMIN_TELEGRAM_ID,
          `👆 سكرين شوت تحويل من مستخدم.\nعشان تفعّله بعد ما تتأكد، ابعت:\n<code>فعل ${userId}</code>`,
          'HTML'
        );
        await sendTelegramMessage(chatId, '✅ وصلت الصورة، هنتأكد ونفعّل اشتراكك في أقرب وقت.');
      } else {
        await sendTelegramMessage(chatId, 'استلمت الصورة 👍');
      }
      return res.status(200).json({ ok: true });
    }

    // --- أمر ربط الحساب بالداشبورد — متاح دايمًا حتى من غير اشتراك فعّال، عشان اليوزر يقدر يربط قبل ما يدفع ---
    if (message.text && ['/link', 'ربط', 'اربط حسابي', 'ربط الحساب'].includes(message.text.trim())) {
      const result = await createLinkCode(userId, chatId);
      if (!result) {
        await sendTelegramMessage(chatId, '❌ حصل خطأ، جرب تاني كمان شوية.');
      } else {
        await sendTelegramMessage(
          chatId,
          `🔗 <b>كود ربط حسابك بالداشبورد</b>\n\n<code>${result.code}</code>\n\nادخل بيه في صفحة "ربط الحساب" في موقع فلوسي بوت خلال 10 دقايق. لو الكود انتهى، ابعت /link تاني وهبعتلك كود جديد.`,
          'HTML'
        );
      }
      return res.status(200).json({ ok: true });
    }

    // --- أمر "اشتراكي" — متاح دايمًا لأي حد، بيوريه حالة اشتراكه ---
    if (message.text && ['اشتراكي', 'الاشتراك', '/subscription'].includes(message.text.trim())) {
      const expiresAt = await getSubscriptionExpiry(userId);
      const active = expiresAt && expiresAt.getTime() > Date.now();
      if (active) {
        const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        const formattedDate = expiresAt.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
        await sendTelegramMessage(chatId, `✅ اشتراكك شغال لحد ${formattedDate} (باقي ${daysLeft} يوم).`, 'HTML');
      } else {
        await sendTelegramMessage(chatId, buildSubscriptionPrompt(Boolean(expiresAt)), 'HTML');
      }
      return res.status(200).json({ ok: true });
    }

    // --- البوابة: أي استخدام تاني للبوت (صوت، مصروف، تقرير، إلخ) محتاج اشتراك فعّال ---
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      const expiresAt = await getSubscriptionExpiry(userId);
      await sendTelegramMessage(chatId, buildSubscriptionPrompt(Boolean(expiresAt)), 'HTML');
      return res.status(200).json({ ok: true });
    }

    // --- حالة 1: رسالة صوتية ---
    if (message.voice) {
      const text = await transcribeVoice(message.voice.file_id);
      await handleIncomingText(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    // --- حالة 2: رسالة نصية ---
    if (message.text) {
      const text = message.text.trim();

      // أمر التقرير الشهري
      if (['تقرير', 'التقرير', '/report'].includes(text)) {
        await sendMonthlyReport(userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // أمر التقرير الأسبوعي
      if (['تقرير الاسبوع', 'تقرير الأسبوع', 'تقرير أسبوعي', 'الاسبوع', '/weekly'].includes(text)) {
        await sendWeeklyReport(userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // أمر تصدير البيانات
      if (['صدّر البيانات', 'صدر البيانات', 'تصدير البيانات', 'تصدير', '/export'].includes(text)) {
        await sendDataExport(userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // أمر ملخص الديون العام
      if (['ديون', 'الديون', '/debts'].includes(text)) {
        await sendDebtsReport(userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // "ديون + اسم شخص" → تفاصيل الشخص ده بالذات
      const personDetailMatch = text.match(/^(?:ديون|الديون)\s+(.+)$/);
      if (personDetailMatch) {
        const personName = personDetailMatch[1].trim();
        await sendPersonDebtDetail(personName, userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // بحث في المصاريف: "دور على قهوة" / "ابحث عن قهوة" / "فين صرفت على قهوة" / "بحث قهوة"
      const searchMatch = text.match(/^(?:دور على|ابحث عن|فين صرفت على|بحث)\s+(.+)$/);
      if (searchMatch) {
        const keyword = searchMatch[1].trim();
        await sendExpenseSearch(keyword, userId, chatId);
        return res.status(200).json({ ok: true });
      }

      // أمر البداية
      if (text === '/start') {
        const replyMarkup = GUIDE_URL
          ? {
              inline_keyboard: [
                [{ text: '📖 دليل الاستخدام الكامل', web_app: { url: GUIDE_URL } }],
              ],
            }
          : undefined;

        await sendTelegramMessage(
          chatId,
          'أهلاً بيك في فلوسي 👋\n\n' +
            'ابعتلي فويس نوت أو رسالة زي "صرفت 50 جنيه أكل" وهسجلها لك.\n' +
            'كمان تقدر تسجل ديون بينك وبين الناس، زي "عطيت محمد 200 جنيه" أو "استلفت من سارة 100 جنيه".\n\n' +
            '📊 <b>تقرير</b> — ملخص شهري بالرسم البياني\n' +
            '📅 <b>تقرير الأسبوع</b> — ملخص آخر 7 أيام\n' +
            '💳 <b>ديون</b> — ملخص كل الديون\n' +
            '👤 <b>ديون محمد</b> — تفاصيل الديون مع شخص معيّن\n' +
            '✅ <b>خلصت مع محمد</b> — تسوية وتصفير الرصيد مع شخص\n' +
            '🔍 <b>دور على قهوة</b> — بحث في مصاريفك بأي كلمة\n' +
            '📁 <b>صدّر البيانات</b> — ملف CSV بكل بياناتك\n' +
            '🔗 <b>/link</b> — كود لربط حسابك بالداشبورد على الموقع\n\n' +
            (GUIDE_URL ? 'اضغط الزرار تحت عشان تشوف كل التفاصيل بشكل مرتّب 👇' : ''),
          'HTML',
          replyMarkup
        );
        return res.status(200).json({ ok: true });
      }

      // غير كده، اعتبرها مصروف أو دين أو تسوية
      await handleIncomingText(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ ok: true }); // نرجع 200 دايمًا عشان تليجرام متعملش retry مزعج
  }
}

// ============ معالجة أي رسالة نصية: تصنيف ثم توجيه (مصروف / دين / تسوية) ============
async function handleIncomingText(text, userId, chatId) {
  if (!text) {
    await sendTelegramMessage(chatId, 'معرفتش أفهم الرسالة، ممكن تعيدها؟');
    return;
  }

  const result = await classifyMessage(text);

  if (result.type === 'expense' && result.amount) {
    await recordExpense(result, text, userId, chatId);
    return;
  }

  if (result.type === 'debt' && result.amount && result.person) {
    await recordDebt(result, userId, chatId);
    return;
  }

  if (result.type === 'settlement' && result.person) {
    await settleDebtWithPerson(result.person, userId, chatId);
    return;
  }

  await sendTelegramMessage(
    chatId,
    'مش قادر أحدد المبلغ من رسالتك 🤔\nجرب تبعت زي كده: "صرفت 50 جنيه أكل" أو "عطيت محمد 200 جنيه" أو "خلصت مع محمد"'
  );
}
