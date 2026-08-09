import { transcribeVoice, classifyMessage } from '../lib/groq.js';
import { sendTelegramMessage, forwardTelegramMessage } from '../lib/telegram.js';
import { recordExpense, sendMonthlyReport, sendWeeklyReport, sendDataExport, sendExpenseSearch } from '../lib/expenses.js';
import { recordDebt, sendDebtsReport, sendPersonDebtDetail, settleDebtWithPerson } from '../lib/debts.js';
import { upsertUser, hasActiveSubscription, getSubscriptionExpiry, activateSubscription, getChatIdByUserId, isInTrial, getTrialDaysLeft } from '../lib/users.js';
import { createLinkCode } from '../lib/linking.js';
import { GUIDE_URL, ADMIN_TELEGRAM_ID, SUBSCRIPTION_DAYS, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK, ADMIN_CONTACT_USERNAME } from '../lib/config.js';

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
    ? '⏳ اشتراكك في Dabbar خلص.'
    : trialEnded
      ? '⏳ خلصت أيام التجربة المجانية الـ3.\n\n💡 جربت 3 أيام وشفت إزاي Dabbar بيتابعلك مصاريفك وديونك أول بأول من غير ما تفتح جدول ولا تكتب رقم بإيدك — دلوقتي كمّل معاك عشان متفوّتش أي تفصيلة من حساباتك.'
      : '🔒 محتاج تشترك الأول عشان تستخدم Dabbar.';

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
      `🎉 تم تفعيل اشتراكك في Dabbar لحد ${formattedDate}.\nابعتلي فويس أو رسالة زي "صرفت 50 جنيه أكل" وابدأ على طول.`
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
      const result = await createLinkCode(userId, chatId);
      if (!result) {
        await sendTelegramMessage(chatId, '❌ حصل خطأ، جرب تاني كمان شوية.');
      } else {
        await sendTelegramMessage(
          chatId,
          `🔗 <b>كود ربط حسابك بالداشبورد</b>\n\n<code>${result.code}</code>\n\nادخل بيه في صفحة "ربط الحساب" في موقع Dabbar خلال 10 دقايق. لو الكود انتهى، ابعت /link تاني وهبعتلك كود جديد.`,
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
      await sendTelegramMessage(chatId, '📋 <b>كل أوامر Dabbar</b>\n\n' + buildCommandsGuide(), 'HTML', replyMarkup);
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
            `💡 استغل الأيام دي وشوف إزاي Dabbar بيوفّرلك وقت وبيتابعلك مصاريفك من غير أي مجهود. ` +
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
            `💡 خلال الـ3 أيام دي شفت بنفسك إزاي Dabbar بيوفّرلك وقت وبيخليك متابع كل جنيه بيتصرف — ` +
            `عشان الخدمة متتقطعش، اشترك بـ<b>${SUBSCRIPTION_PRICE_EGP} ج.م/شهر</b>.`,
          'HTML'
        );
      }
    }

    // --- حالة 1: رسالة صوتية — بتتفرّغ لنص وبعدين تتوجّه بنفس منطق الرسالة النصية بالظبط ---
    // (قبل كده كانت بتتفرّغ وتروح على طول للتصنيف الذكي (مصروف/دين) من غير ما تعدّي على أوامر
    // زي "تقرير" أو "ديون" أو "دور على" — يعني الأوامر دي كانت مش شغالة بالصوت. اتصلحت دلوقتي.)
    if (message.voice) {
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
          'أهلاً بيك في Dabbar 👋\n\n' +
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

// ============ تحويل الأرقام العربية/الهندية والفارسية (٠١٢٣٤٥٦٧٨٩ / ۰۱۲۳۴۵۶۷۸۹) لأرقام إنجليزية عادية ============
// من غير ده، لو المستخدم كتب "٨٠٠٠٠" بدل "80000"، النص بيروح للـ AI (Groq) زي ما هو والموديل
// أحيانًا بيقرأ العدد أو الأصفار غلط (بيزوّد أو ينقّص صفر). التحويل ده بيتم أول حاجة قبل أي
// معالجة تانية للنص، عشان كل حاجة بعد كده (تصنيف، أوامر، أسماء) تشتغل على أرقام إنجليزية مضمونة.
function normalizeDigits(text) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return text.replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d)))
             .replace(/[۰-۹]/g, (d) => String(persian.indexOf(d)));
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

  text = normalizeDigits(text);

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

// ============ التصنيف الذكي لأي رسالة (مصروف / دين / تسوية) — بيتنادى بس لو الرسالة مش أمر معروف ============
async function handleIncomingText(text, userId, chatId) {
  if (!text) {
    await sendTelegramMessage(chatId, 'معرفتش أفهم الرسالة، ممكن تعيدها؟');
    return;
  }

  const transactions = await classifyMessage(text);
  let successCount = 0;

  for (const result of transactions) {
    if (result.type === 'expense' && result.amount) {
      await recordExpense(result, text, userId, chatId);
      successCount++;
    } else if (result.type === 'debt' && result.amount && result.person) {
      await recordDebt(result, userId, chatId);
      successCount++;
    } else if (result.type === 'settlement' && result.person) {
      await settleDebtWithPerson(result.person, userId, chatId);
      successCount++;
    }
  }

  if (successCount === 0) {
    await sendTelegramMessage(
      chatId,
      'مش قادر أحدد المعاملات من رسالتك 🤔\nجرب تبعت زي كده: "صرفت 50 جنيه أكل" أو "عطيت محمد 200 جنيه" أو "خلصت مع محمد"'
    );
  } else if (transactions.length > 1 && successCount > 0) {
    await sendTelegramMessage(chatId, `✅ تم تسجيل ${successCount} معاملة بنجاح.`);
  }
}
