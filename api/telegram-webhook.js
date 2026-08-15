import { transcribeVoice, classifyMessage } from '../lib/groq.js';
import { tryUseVoiceQuota } from '../lib/voiceUsage.js';
import { tryUseTextQuota } from '../lib/textUsage.js';
import { sendTelegramMessage, forwardTelegramMessage, answerCallbackQuery } from '../lib/telegram.js';
import { recordExpense, sendDataExport, sendExpenseSearch } from '../lib/expenses.js';
import { sendMonthlyReport, sendWeeklyReport } from '../lib/expensesReports.js';
import { recordDebt, settleDebtWithPerson } from '../lib/debts.js';
import { sendDebtsReport, sendPersonDebtDetail } from '../lib/debtsReports.js';
import { upsertUser, hasActiveSubscription, getSubscriptionExpiry, activateSubscription, getChatIdByUserId, isInTrial, getTrialDaysLeft } from '../lib/users.js';
import { createLinkCode } from '../lib/linking.js';
import { resolveAmountConfidence } from '../lib/numberExtraction.js';
import { normalizeEgyptianText } from '../lib/egyptianNormalize.js';
import { createPendingConfirmation, getPendingConfirmation, deletePendingConfirmation } from '../lib/confirmations.js';
import { CATEGORY_EMOJI, GUIDE_URL, ADMIN_TELEGRAM_ID, SUBSCRIPTION_DAYS, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK, ADMIN_CONTACT_USERNAME, TELEGRAM_WEBHOOK_SECRET } from '../lib/config.js';

// ============ نص دليل الأوامر — بيتبعت مع /start وبرضو متاح في أي وقت عن طريق "مساعدة" ============
function buildCommandsGuide() {
  return (
    'ابعتلي فويس نوت أو رسالة، وهسجلها لك — كل الأوامر تحت شغالة بالصوت أو بالكتابة بالظبط زي بعض.\n\n' +
    '💸 <b>مصروف</b> — "صرفت 50 جنيه أكل"\n' +
    '🤝 <b>دين جديد</b> — "عطيت محمد 200 جنيه" أو "استلفت من سارة 100 جنيه"\n' +
    '↩️ <b>مرتجع (سداد دين قديم)</b> — "مرتجع من محمد 100 جنيه" أو "رجّعت لسارة 50 جنيه"\n\n' +
    '📊 <b>تقرير</b> — ملخص شهري بالرسم البياني\n' +
    '📅 <b>تقرير الأسبوع</b> — ملخص آخر 7 أيام\n' +
    '💳 <b>ديون</b> — ملخص كل الديون\n' +
    '👤 <b>ديون محمد</b> — تفاصيل الديون مع شخص معيّن\n' +
    '✅ <b>خلصت مع محمد</b> — تسوية وتصفير الرصيد مع شخص\n' +
    '🔍 <b>دور على قهوة</b> — بحث في مصاريفك بأي كلمة\n' +
    '📁 <b>صدّر البيانات</b> — ملف بكل بياناتك (CSV و TXT)\n' +
    '💰 <b>اشتراكي</b> — تعرف حالة اشتراكك وتاريخ انتهائه\n' +
    '🔗 <b>/link</b> — كود لربط حسابك بالداشبورد على الموقع\n' +
    '❓ <b>مساعدة</b> — تشوف القايمة دي تاني في أي وقت'
  );
}

// ============ رسالة "محتاج تشترك" — بتتبعت لأي حد الاشتراك بتاعه مش فعّال ============
function buildSubscriptionPrompt(isExpired, trialEnded = false) {
  const intro = isExpired
    ? '⏳ اشتراكك في دبّر خلص.'
    : trialEnded
      ? '⏳ خلصت أيام التجربة المجانية الـ3.\n\n💡 جربت 3 أيام وشفت إزاي دبّر بيتابعلك مصاريفك وديونك أول بأول من غير ما تفتح جدول ولا تكتب رقم بإيدك — دلوقتي كمّل معاك عشان متفوّتش أي تفصيلة من حساباتك.'
      : '🔒 محتاج تشترك الأول عشان تستخدم دبّر.';

  return (
    `${intro}\n\n` +
    `💳 الاشتراك الشهري: <b>${SUBSCRIPTION_PRICE_EGP} ج.م</b>\n\n` +
    `1️⃣ حوّل عن طريق إنستا باي على الرقم: <code>${INSTAPAY_LINK}</code>\n` +
    `2️⃣ صوّر الإيصال، واكتب اسمك اللي حولت بيه في نفس رسالة الصورة (تحتها كتابة)\n` +
    `3️⃣ ابعت الصورة هنا في الشات\n\n` +
    `بمجرد ما نتأكد من التحويل، هيتفعّل اشتراكك على طول وترجع تقدر تستخدم البوت عادي.`
  );
}

// ============ أمر الأدمن السرّي لتفعيل اشتراك مستخدم بعد ما يبعت إيصال الدفع ============
// الصيغة: "فعل <telegram_user_id>" أو "فعل <telegram_user_id> <عدد الأيام>"
// بيشتغل بس لو الرسالة جاية من ADMIN_TELEGRAM_ID، أي حد تاني بيتجاهل الأمر ده تمامًا.
async function tryHandleAdminActivation(text, fromUserId, adminChatId) {
  if (!ADMIN_TELEGRAM_ID || fromUserId !== ADMIN_TELEGRAM_ID) return false;

  const match = text.match(/^فعّ?ل\s+(-?\d+)(?:\s+(\d+))?$/);
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
      `🎉 تم تفعيل اشتراكك في دبّر لحد ${formattedDate}.\nابعتلي فويس أو رسالة زي "صرفت 50 جنيه أكل" وابدأ على طول.`
    );
  }
  return true;
}

// ============ نقطة الدخول - Vercel بينادي الدالة دي لكل ريكوست ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  // ---- تأمين الويب هوك: نتأكد إن الطلب جاي فعليًا من تليجرام مش من أي حد عارف الرابط ----
  // من غير الفحص ده، أي حد يعرف رابط الويب هوك يقدر يبعت POST مباشر ويتظاهر إنه ADMIN_TELEGRAM_ID
  // (بمجرد ما يحط نفس الرقم في message.from.id بالطلب المزيّف)، ويفعّل اشتراكات ببلاش لنفسه أو
  // لأي حد. تليجرام بيبعت الهيدر ده تلقائيًا مع كل ريكوست حقيقي لو ضبطناه وقت setWebhook (شوف README).
  if (TELEGRAM_WEBHOOK_SECRET) {
    const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (incomingSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const update = req.body;

    // --- ضغطة على زرار تأكيد المبلغ (⬅️ من رسالة "تقصد X ولا Y؟") — مسار منفصل تمامًا عن الرسايل العادية ---
    if (update.callback_query) {
      await handleConfirmationCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

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
    // بنطلب من اليوزر يكتب اسمه في نفس رسالة الصورة (caption)، عشان الأدمن يقدر يتأكد من التحويل
    // بسرعة (يقارن الاسم بالاسم اللي ظهر في إنستا باي) من غير ما يحتاج يسأله تاني.
    if (message.photo) {
      const senderName = message.caption ? message.caption.trim() : '';

      if (ADMIN_TELEGRAM_ID && userId !== ADMIN_TELEGRAM_ID) {
        await forwardTelegramMessage(ADMIN_TELEGRAM_ID, chatId, message.message_id);

        if (senderName) {
          await sendTelegramMessage(
            ADMIN_TELEGRAM_ID,
            `👆 سكرين شوت تحويل من مستخدم.\n👤 الاسم اللي بعته: <b>${senderName}</b>\n\nقارن الاسم ده باللي ظهرلك في إنستا باي، ولو تمام ابعت:\n<code>فعل ${userId}</code>`,
            'HTML'
          );
          await sendTelegramMessage(
            chatId,
            `✅ وصلت الصورة باسم "<b>${senderName}</b>"، هنتأكد من إنستا باي ونفعّل اشتراكك في أقرب وقت.`,
            'HTML'
          );
        } else {
          await sendTelegramMessage(
            ADMIN_TELEGRAM_ID,
            `👆 سكرين شوت تحويل من مستخدم (من غير اسم — اطلب منه يبعته تاني بالاسم، أو دوّر على الاسم في الإيصال نفسه).\nلو اتأكدت، فعّله بـ:\n<code>فعل ${userId}</code>`,
            'HTML'
          );
          await sendTelegramMessage(
            chatId,
            '✅ وصلت الصورة! بس عشان نفعّلك أسرع، ابعتها تاني وحط اسمك اللي حولت بيه في نفس الرسالة (تحت الصورة تمام) — كده هنتأكد من التحويل ونفعّلك على طول.'
          );
        }
      } else {
        await sendTelegramMessage(chatId, 'استلمت الصورة 👍');
      }
      return res.status(200).json({ ok: true });
    }

    // --- أمر ربط الحساب بالداشبورد — متاح دايمًا حتى من غير اشتراك فعّال، عشان اليوزر يقدر يربط قبل ما يدفع ---
    // بيتقبل كمان "/start link": ده بييجي أوتوماتيك لما اليوزر يدوس زرار "افتح البوت" من صفحة الربط
    // في الموقع (رابط زي t.me/Masaaref_bot?start=link) — بنعامله بالظبط زي /link عادي، عشان الكود
    // يوصله على طول من غير ما يكتب حاجة بنفسه.
    if (message.text && ['/link', 'ربط', 'اربط حسابي', 'ربط الحساب', '/start link'].includes(message.text.trim())) {
      const result = await createLinkCode(userId, chatId, message.from.first_name || null);
      if (!result) {
        await sendTelegramMessage(chatId, '❌ حصل خطأ، جرب تاني كمان شوية.');
      } else {
        await sendTelegramMessage(
          chatId,
          `🔗 <b>كود ربط حسابك بالداشبورد</b>\n\n<code>${result.code}</code>\n\nادخل بيه في صفحة "ربط الحساب" في موقع دبّر خلال 10 دقايق. لو الكود انتهى، ابعت /link تاني وهبعتلك كود جديد.`,
          'HTML'
        );
      }
      return res.status(200).json({ ok: true });
    }

    // --- أمر "مساعدة" — دليل كل أوامر البوت، متاح دايمًا لأي حد حتى من غير اشتراك فعّال ---
    if (message.text && ['مساعدة', 'المساعدة', 'الأوامر', 'أوامر', '/help'].includes(message.text.trim())) {
      const replyMarkup = GUIDE_URL
        ? { inline_keyboard: [[{ text: '📖 دليل الاستخدام الكامل', web_app: { url: GUIDE_URL } }]] }
        : undefined;
      await sendTelegramMessage(chatId, '📋 <b>كل أوامر دبّر</b>\n\n' + buildCommandsGuide(), 'HTML', replyMarkup);
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
      } else if (await isInTrial(userId)) {
        const trialDaysLeft = await getTrialDaysLeft(userId);
        await sendTelegramMessage(
          chatId,
          `🎁 لسه في تجربتك المجانية، باقي ${trialDaysLeft} يوم.\n\n` +
            `💡 استغل الأيام دي وشوف إزاي دبّر بيوفّرلك وقت وبيتابعلك مصاريفك من غير أي مجهود. ` +
            `بعد كده الاشتراك الشهري <b>${SUBSCRIPTION_PRICE_EGP} ج.م</b>.`,
          'HTML'
        );
      } else {
        await sendTelegramMessage(chatId, buildSubscriptionPrompt(Boolean(expiresAt), true), 'HTML');
      }
      return res.status(200).json({ ok: true });
    }

    // --- البوابة: أي استخدام تاني للبوت (صوت، مصروف، تقرير، إلخ) محتاج اشتراك فعّال أو تجربة مجانية شغالة ---
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      const inTrial = await isInTrial(userId);
      if (!inTrial) {
        const expiresAt = await getSubscriptionExpiry(userId);
        await sendTelegramMessage(chatId, buildSubscriptionPrompt(Boolean(expiresAt), true), 'HTML');
        return res.status(200).json({ ok: true });
      }
      // لسه في التجربة المجانية — نديله تنبيه بسيط لو الأيام قربت تخلص، ونكمل عادي
      const daysLeft = await getTrialDaysLeft(userId);
      if (daysLeft <= 1) {
        await sendTelegramMessage(
          chatId,
          `⏳ باقي أقل من يوم على نهاية تجربتك المجانية.\n\n` +
            `💡 خلال الـ3 أيام دي شفت بنفسك إزاي دبّر بيوفّرلك وقت وبيخليك متابع كل جنيه بيتصرف — ` +
            `عشان الخدمة متتقطعش، اشترك بـ<b>${SUBSCRIPTION_PRICE_EGP} ج.م/شهر</b>.`,
          'HTML'
        );
      }
    }

    // --- حالة 1: رسالة صوتية — بتتفرّغ لنص وبعدين تتوجّه بنفس منطق الرسالة النصية بالظبط ---
    // (قبل كده كانت بتتفرّغ وتروح على طول للتصنيف الذكي (مصروف/دين) من غير ما تعدّي على أوامر
    // زي "تقرير" أو "ديون" أو "دور على" — يعني الأوامر دي كانت مش شغالة بالصوت. اتصلحت دلوقتي.)
    if (message.voice) {
      // ---- نفس الحد اليومي المطبّق في الداشبورد، عشان مفيش ثغرة لو حد استخدم تليجرام بدل الموقع ----
      const allowed = await tryUseVoiceQuota(userId);
      if (!allowed) {
        await sendTelegramMessage(chatId, '🎙️ خد راحة من التسجيلات الصوتية النهاردة (استخدمتها كتير، تسلم إيدك 💪). ابعتها كتابةً دلوقتي وهتتسجل عادي، وترجعلك الميزة الصوتية تاني بكرة.');
        return res.status(200).json({ ok: true });
      }
      // ---- نفس حد الـ45 ثانية المطبّق على تسجيل الداشبورد (شوف dabbar-dashboard-full.html)،
      // عشان تليجرام كان بيسمح بفويس نوت بأي طول من غير حماية، وده بيكلّف فلوس Groq زيادة
      // (تكلفة Whisper بتتحسب على مدة الصوت). تليجرام بيبعتلنا مدة التسجيل جاهزة في الرسالة
      // نفسها (duration بالثواني)، فمحتاجين نتأكد منها بس قبل ما ننزّل الملف ونكلّم Groq أصلًا.
      const MAX_TELEGRAM_VOICE_SECONDS = 45;
      if (Number(message.voice.duration) > MAX_TELEGRAM_VOICE_SECONDS) {
        await sendTelegramMessage(chatId, `🎙️ التسجيل طويل أوي، جرب تختصره في ${MAX_TELEGRAM_VOICE_SECONDS} ثانية (كفاية تقول فيها كذا مصروف براحتك).`);
        return res.status(200).json({ ok: true });
      }
      const text = await transcribeVoice(message.voice.file_id);
      await routeUserMessage(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    // --- حالة 2: رسالة نصية ---
    if (message.text) {
      const text = message.text.trim();

      // أمر البداية (بيتفحص هنا بس، مش جزء من routeUserMessage، عشان مش متوقع حد يقوله بالصوت)
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
          'أهلاً بيك في دبّر 👋\n\n' +
            '🎁 عندك 3 أيام تجربة مجانية بكل المميزات، وبعدها الاشتراك الشهري ' +
            `<b>${SUBSCRIPTION_PRICE_EGP} ج.م</b>.\n\n` +
            buildCommandsGuide() +
            '\n\n' +
            (GUIDE_URL ? 'اضغط الزرار تحت عشان تشوف كل التفاصيل بشكل مرتّب 👇' : ''),
          'HTML',
          replyMarkup
        );
        return res.status(200).json({ ok: true });
      }

      await routeUserMessage(text, userId, chatId);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ ok: true }); // نرجع 200 دايمًا عشان تليجرام متعملش retry مزعج
  }
}

// ============ نقطة توجيه موحّدة لأي نص جاي من المستخدم (سواء مكتوب أو مفرّغ من فويس نوت) ============
// بتفحص الأوامر الثابتة الأول (تقرير/ديون/دور على/صدّر البيانات)، ولو مفيش أمر معروف تعتبرها
// مصروف أو دين أو تسوية وتبعتها للتصنيف الذكي. المسار ده واحد لكل من الكتابة والصوت، عشان
// أي أمر بتقوله بالصوت يشتغل بالظبط زي ما لو كتبته.
async function routeUserMessage(text, userId, chatId) {
  if (!text) {
    await sendTelegramMessage(chatId, 'معرفتش أفهم الرسالة، ممكن تعيدها؟');
    return;
  }

  text = normalizeEgyptianText(text);

  // أمر التقرير الشهري
  if (['تقرير', 'التقرير', '/report'].includes(text)) {
    await sendMonthlyReport(userId, chatId);
    return;
  }

  // أمر التقرير الأسبوعي
  if (['تقرير الاسبوع', 'تقرير الأسبوع', 'تقرير أسبوعي', 'الاسبوع', '/weekly'].includes(text)) {
    await sendWeeklyReport(userId, chatId);
    return;
  }

  // أمر تصدير البيانات
  if (['صدّر البيانات', 'صدر البيانات', 'تصدير البيانات', 'تصدير', '/export'].includes(text)) {
    await sendDataExport(userId, chatId);
    return;
  }

  // أمر ملخص الديون العام
  if (['ديون', 'الديون', '/debts'].includes(text)) {
    await sendDebtsReport(userId, chatId);
    return;
  }

  // "ديون + اسم شخص" → تفاصيل الشخص ده بالذات (نص أو PDF لو العمليات كتير)
  const personDetailMatch = text.match(/^(?:ديون|الديون)\s+(.+)$/);
  if (personDetailMatch) {
    const personName = personDetailMatch[1].trim();
    await sendPersonDebtDetail(personName, userId, chatId);
    return;
  }

  // بحث في المصاريف: "دور على قهوة" / "ابحث عن قهوة" / "فين صرفت على قهوة" / "بحث قهوة"
  const searchMatch = text.match(/^(?:دور على|ابحث عن|فين صرفت على|بحث)\s+(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    await sendExpenseSearch(keyword, userId, chatId);
    return;
  }

  // غير كده، اعتبرها مصروف أو دين أو تسوية، وابعتها للتصنيف الذكي
  await handleIncomingText(text, userId, chatId);
}

// ============ رد على ضغطة زرار تأكيد/رفض مبلغ معلّق ============
// callback_data شكله "cy:<id>" (أيوه، سجّل زي ما هو) أو "cn:<id>" (لأ، إلغاء). الـ id بيرجّع
// لنا المعاملة الكاملة من جدول pending_confirmations (شوف lib/confirmations.js).
async function handleConfirmationCallback(cq) {
  const callbackId = cq.id;
  const data = String(cq.data || '');
  const chatId = cq.message?.chat?.id;
  const match = data.match(/^(cy|cn):(.+)$/);

  if (!match) {
    await answerCallbackQuery(callbackId);
    return;
  }

  const [, action, id] = match;
  const pending = await getPendingConfirmation(id);

  if (!pending) {
    await answerCallbackQuery(callbackId, '⏰ انتهت صلاحية التأكيد ده');
    if (chatId) {
      await sendTelegramMessage(chatId, '⏰ التأكيد ده اتلغى أو خلصت صلاحيته (أكتر من يوم). لو لسه محتاج تسجلها، ابعتها تاني.');
    }
    return;
  }

  await deletePendingConfirmation(id);

  if (action === 'cn') {
    await answerCallbackQuery(callbackId, 'اتلغت ❌');
    await sendTelegramMessage(pending.chat_id, '❌ اتلغت المعاملة دي. ابعتها تاني بشكل أوضح (خصوصًا المبلغ) لو حابب تسجلها.');
    return;
  }

  // action === 'cy' — المستخدم أكّد إن المبلغ اللي فهمناه صح، ننفّذ فعليًا دلوقتي بس
  await answerCallbackQuery(callbackId, 'تمام ✅');
  if (pending.kind === 'expense') {
    await recordExpense(pending.payload, pending.raw_text || '', pending.telegram_user_id, pending.chat_id);
  } else if (pending.kind === 'debt') {
    await recordDebt(pending.payload, pending.telegram_user_id, pending.chat_id);
  }
}

// ============ بناء نص السؤال عن المبلغ ============
// لو فيه تعارض حجم واضح (10x/100x — أخطر أنواع غلط الـ ASR)، بنعرض الاختيار صراحةً بين رقم
// الموديل والرقم الحتمي البديل بدل سؤال عمومي، عشان المستخدم يرد بضغطة واحدة بدل ما يعيد الكتابة.
function buildAmountQuestion(modelAmount, deterministicAmounts, magnitudeConflict) {
  if (magnitudeConflict && deterministicAmounts.length > 0) {
    const alt = deterministicAmounts.find((n) => n !== modelAmount) ?? deterministicAmounts[0];
    return `تقصد ${modelAmount} جنيه ولا ${alt} جنيه؟`;
  }
  return `تقصد ${modelAmount} جنيه؟`;
}

function confirmationKeyboard(id, modelAmount) {
  return {
    inline_keyboard: [[
      { text: `✅ أيوه، ${modelAmount} جنيه`, callback_data: `cy:${id}` },
      { text: '❌ لأ، إلغاء', callback_data: `cn:${id}` },
    ]],
  };
}

// ============ طلب تأكيد مصروف — مبلغه محتاج مراجعة قبل ما يتسجّل فعليًا ============
async function askExpenseConfirmation(result, text, userId, chatId, conf) {
  const id = await createPendingConfirmation(
    userId, chatId, 'expense',
    { amount: Number(result.amount), category: result.category, note: result.note || '' },
    text
  );
  if (!id) {
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بحاول أتأكد من المبلغ، جرب تبعتها تاني.');
    return;
  }
  const emoji = CATEGORY_EMOJI[result.category] || '📌';
  const detail = result.note && result.note.trim() ? ` (${result.note.trim()})` : '';
  const question = buildAmountQuestion(Number(result.amount), conf.deterministicAmounts, conf.magnitudeConflict);
  await sendTelegramMessage(
    chatId,
    `🤔 <b>مش متأكد من المبلغ</b>\n${emoji} ${result.category}${detail}\n${question}`,
    'HTML',
    confirmationKeyboard(id, Number(result.amount))
  );
}

// ============ طلب تأكيد دين/سلفة — نفس فكرة المصروف بالظبط ============
async function askDebtConfirmation(result, text, userId, chatId, conf) {
  const id = await createPendingConfirmation(
    userId, chatId, 'debt',
    {
      person: result.person, amount: Number(result.amount),
      direction: result.direction === 'borrowed' ? 'borrowed' : 'lent',
      is_repayment: Boolean(result.is_repayment), note: result.note || '',
    },
    text
  );
  if (!id) {
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بحاول أتأكد من المبلغ، جرب تبعتها تاني.');
    return;
  }
  const question = buildAmountQuestion(Number(result.amount), conf.deterministicAmounts, conf.magnitudeConflict);
  await sendTelegramMessage(
    chatId,
    `🤔 <b>مش متأكد من المبلغ</b>\n👤 ${result.person}\n${question}`,
    'HTML',
    confirmationKeyboard(id, Number(result.amount))
  );
}

// ============ التصنيف الذكي لأي رسالة (مصروف / دين / تسوية) — بيتنادى بس لو الرسالة مش أمر معروف ============
// ملحوظة أساسية: المبلغ في أي معاملة مش بيتنفّذ (يتسجّل في الداتابيز) غير لو الثقة فيه عالية
// (شوف lib/numberExtraction.js -> resolveAmountConfidence). لو محتاج تأكيد، بنطلبه من المستخدم
// بزرار بدل ما نخمّن — وده بيتم لكل معاملة على حدة (مش الرسالة كلها) عشان لو فيه 3 عمليات
// واضحة وواحدة بس غامضة، الـ3 بيتسجلوا فورًا وبنسأل بس عن اللي محتاجة تأكيد.
async function handleIncomingText(text, userId, chatId) {
  if (!text) {
    await sendTelegramMessage(chatId, 'معرفتش أفهم الرسالة، ممكن تعيدها؟');
    return;
  }

  // ---- الحد اليومي لعدد رسايل النص اللي بتتصنّف بالـ AI: نفس فكرة تسجيلات الصوت بالظبط ----
  const allowed = await tryUseTextQuota(userId);
  if (!allowed) {
    await sendTelegramMessage(
      chatId,
      '📝 خد راحة شوية (استخدمت رسايلك النهاردة، تسلم إيدك 💪). هترجعلك الميزة تاني بكرة.'
    );
    return;
  }

  // ---- تطبيع (أرقام + تصحيحات إملائية شائعة) قبل التصنيف والاستخراج الحتمي، عشان الاتنين
  // يشتغلوا على نفس النسخة بالظبط من النص ----
  const normalizedText = normalizeEgyptianText(text);
  const transactions = await classifyMessage(normalizedText);
  let successCount = 0;
  let pendingCount = 0;

  for (const result of transactions) {
    if (result.type === 'expense' && result.amount) {
      const conf = resolveAmountConfidence(Number(result.amount), result.confidence, normalizedText);
      if (conf.requiresConfirmation) {
        await askExpenseConfirmation(result, normalizedText, userId, chatId, conf);
        pendingCount++;
      } else {
        await recordExpense(result, normalizedText, userId, chatId);
        successCount++;
      }
    } else if (result.type === 'debt' && result.amount && result.person) {
      const conf = resolveAmountConfidence(Number(result.amount), result.confidence, normalizedText);
      if (conf.requiresConfirmation) {
        await askDebtConfirmation(result, normalizedText, userId, chatId, conf);
        pendingCount++;
      } else {
        await recordDebt(result, userId, chatId);
        successCount++;
      }
    } else if (result.type === 'settlement' && result.person) {
      await settleDebtWithPerson(result.person, userId, chatId);
      successCount++;
    }
  }

  if (successCount === 0 && pendingCount === 0) {
    await sendTelegramMessage(
      chatId,
      'مش قادر أحدد المعاملات من رسالتك 🤔\nجرب تبعت زي كده: "صرفت 50 جنيه أكل" أو "عطيت محمد 200 جنيه" أو "خلصت مع محمد"'
    );
  } else if (transactions.length > 1 && successCount > 0) {
    const pendingNote = pendingCount > 0 ? ` (وفيه ${pendingCount} محتاجة تأكيد المبلغ فوق ⬆️)` : '';
    await sendTelegramMessage(chatId, `✅ تم تسجيل ${successCount} معاملة بنجاح${pendingNote}.`);
  }
}
