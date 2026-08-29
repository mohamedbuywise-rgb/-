import { transcribeVoice, classifyMessage, answerDataQuestion, extractItemizedReceiptFromImage } from '../../lib/groq.js';
import { recordInvoice, deleteInvoiceById } from '../../lib/invoices.js';
import { sendTelegramMessage, forwardTelegramMessage, answerCallbackQuery, editTelegramMessage, sendChatAction } from '../../lib/telegram.js';
import { recordExpense, sendMonthlyReport, sendWeeklyReport, sendDataExport, sendExpenseSearch, deleteExpenseById, getMostRecentExpense, getRecentExpensesSummaryText } from '../../lib/expenses.js';
import { recordDebt, sendDebtsReport, sendPersonDebtDetail, settleDebtWithPerson, deleteDebtById, getMostRecentDebt, getDebtsSummaryText } from '../../lib/debts.js';
import { createGoal, contributeToGoal, sendGoalStatus, cancelActiveGoal } from '../../lib/goals.js';
import { sendMonthlyWrapped } from '../../lib/wrapped.js';
import { upsertUser, hasActiveSubscription, getSubscriptionExpiry, activateSubscription, getChatIdByUserId, isInTrial, getTrialDaysLeft } from '../../lib/users.js';
import { createLinkCode } from '../../lib/linking.js';
import { isFinancialEventType, recordFinancialEvent } from '../../lib/financialEvents.js';
import { normalizeDigits, extractDeterministicExpense, correctDebtDirections, correctExpenseMisclassifiedAsDebt, normalizeFinancialTransaction, reconcileSingleTransaction, finalizeTransactions } from '../../lib/textNormalize.js';
import { checkVoiceUsage, checkOcrUsage, checkChatUsage, refundOcrUsage } from '../../lib/rateLimits.js';
import { GUIDE_URL, TRIAL_SUMMARY_BASE_URL, ADMIN_TELEGRAM_ID, SUBSCRIPTION_DAYS, SUBSCRIPTION_PRICE_EGP, INSTAPAY_LINK, ADMIN_CONTACT_USERNAME, VOICE_MAX_DURATION_SECONDS, TELEGRAM_WEBHOOK_SECRET, CATEGORY_EMOJI } from '../../lib/config.js';
import { createTrialSummaryToken } from '../../lib/trialToken.js';

// ============ نص دليل الأوامر — بيتبعت مع /start وبرضو متاح في أي وقت عن طريق "مساعدة" ============
function buildCommandsGuide() {
  return (
    'ابعتلي فويس نوت أو رسالة، وهسجلها لك — كل الأوامر تحت شغالة بالصوت أو بالكتابة بالظبط زي بعض.\n\n' +
    '💸 <b>مصروف</b> — "صرفت 50 جنيه أكل"\n' +
    '🤝 <b>دين جديد</b> — "عطيت محمد 200 جنيه" أو "استلفت من سارة 100 جنيه"\n' +
    '↩️ <b>مرتجع (سداد دين قديم)</b> — "مرتجع من محمد 100 جنيه" أو "رجّعت لسارة 50 جنيه"\n\n' +
    '🎯 <b>هدفي [مبلغ] [اسم]</b> — تحدد هدف ماليّ، مثلاً "هدفي 20000 لابتوب خلال 60 يوم"\n' +
    '💰 <b>وفرت [مبلغ]</b> — تضيف مبلغ موفّر على هدفك الحالي (يتابعك بيه على طول)\n\n' +
    '🔥 <b>حلل الشهر</b> — ملخص Wrapped: أكبر تسريب وفرصة توفير ومقارنة بالشهر اللي فات\n' +
    '📸 <b>ابعت صورة فاتورة</b> — يقرا المبلغ والفئة لوحده ويسجله (مش محتاج تكتب حاجة)\n\n' +
    '📊 <b>تقرير</b> — ملخص شهري بالرسم البياني\n' +
    '📅 <b>تقرير الأسبوع</b> — ملخص آخر 7 أيام\n' +
    '💳 <b>ديون</b> — ملخص كل الديون\n' +
    '👤 <b>ديون محمد</b> — تفاصيل الديون مع شخص معيّن\n' +
    '✅ <b>خلصت مع محمد</b> — تسوية وتصفير الرصيد مع شخص\n' +
    '🔍 <b>دور على قهوة</b> — بحث في مصاريفك بأي كلمة\n' +
    '❓ <b>اسألني أي سؤال عن مصاريفك</b> — زي "صرفت كام على الأكل الشهر ده؟"\n' +
    '🗑 <b>حذف عملية</b> — دوس زرار "🗑 حذف" تحت أي رسالة تسجيل (هيطلب تأكيد قبل ما يمسح)، أو ابعت "امسح آخر مصروف/دين"\n' +
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

// ============ لحظة انتهاء التجربة فعليًا (أول مرة، ولسه ماشتركش قبل كده) ============
// بدل الرسالة النصية الطويلة القديمة، بنبعت تيزر قصير + زرار Web App بيفتح صفحة ملخص التجربة
// (public/app/dabbar-trial-summary.html) اللي فيها بياناته الحقيقية (مصاريفه، أكبر تسريب، فئاته)
// + بانل الدفع الكامل جوه نفس الصفحة. لو TRIAL_SUMMARY_BASE_URL مش متظبط (مفيش دومين Vercel لسه)،
// بنرجع تلقائيًا لنفس رسالة النص القديمة عشان الفلو ميوقفش.
async function sendTrialEndedPrompt(chatId, userId) {
  if (!TRIAL_SUMMARY_BASE_URL) {
    await sendTelegramMessage(chatId, buildSubscriptionPrompt(false, true), 'HTML');
    return;
  }

  const token = createTrialSummaryToken(userId);
  const summaryUrl = `${TRIAL_SUMMARY_BASE_URL}?t=${encodeURIComponent(token)}`;

  await sendTelegramMessage(
    chatId,
    '⏳ خلصت أيام التجربة المجانية الـ3.\n\n' +
      '📊 دوس الزرار تحت عشان تشوف ملخص فعلي لأيامك معانا (مصاريفك، أكبر تسريب، وأهم فئاتك) — وتقدر تشترك من نفس الصفحة كمان.',
    'HTML',
    { inline_keyboard: [[{ text: '📊 شوف ملخص تجربتك واشترك', web_app: { url: summaryUrl } }]] }
  );
}


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

// ============ حذف عملية (مصروف أو دين) عن طريق زرار "🗑 حذف" تحت رسالة التسجيل ============
// ملحوظة مهمة: تليجرام مبيبعتش أي إشعار للبوت لو المستخدم مسح رسالته من الشات (مفيش "message_deleted"
// في الـ Bot API خالص، سواء في شات خاص أو جروب) — فمفيش طريقة نخلي "مسح الرسالة من تليجرام" يمسح
// العملية من قاعدة البيانات تلقائيًا. البديل العملي اللي بيدّي نفس الإحساس: زرار 🗑 تحت كل رسالة تسجيل،
// بيفضل شغال لأي وقت (مش بيتقفل بعد شوية زي أزرار تانية)، فتقدر تمسح أي عملية قديمة برضو لو رجعت للرسالة.
//
// الحذف على خطوتين دايمًا (تأكيد إجباري)، عشان محدش يمسح حاجة بالغلط بضغطة واحدة:
// 1) دوس "🗑 حذف" -> الرسالة بتتغيّر لسؤال تأكيد ("متأكد؟ 🗑 اتأكيد / إلغاء").
// 2) دوس "🗑 اتأكيد" -> ساعتها بس بيتم المسح الفعلي من قاعدة البيانات.
// "إلغاء" أو تجاهل الرسالة بيرجّع زرار "🗑 حذف" العادي زي ما كان، من غير أي حذف.
function buildConfirmMarkup(action, id) {
  return {
    inline_keyboard: [[
      { text: '🗑 اتأكيد الحذف', callback_data: `${action}_yes:${id}` },
      { text: '↩️ إلغاء', callback_data: `${action}_no:${id}` },
    ]],
  };
}

function buildDeleteMarkup(action, id) {
  return { inline_keyboard: [[{ text: '🗑 حذف العملية دي', callback_data: `${action}:${id}` }]] };
}

async function handleDeleteCallback(callbackQuery) {
  const data = callbackQuery.data || '';
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const originalText = callbackQuery.message?.text || '';

  const [rawAction, rawId] = data.split(':');
  const id = Number(rawId);

  if (!id || !chatId || !userId) {
    await answerCallbackQuery(callbackQuery.id, 'حصل خطأ، جرب تاني.');
    return;
  }

  // --- الضغطة الأولى على "🗑 حذف": نستبدل الزرار بسؤال تأكيد، من غير أي مسح فعلي لسه ---
  if (rawAction === 'delexp' || rawAction === 'deldebt' || rawAction === 'delinv') {
    await answerCallbackQuery(callbackQuery.id);
    await editTelegramMessage(chatId, messageId, `${originalText}\n\n⚠️ متأكد إنك عايز تمسح العملية دي؟`, 'HTML', buildConfirmMarkup(rawAction, id));
    return;
  }

  // --- إلغاء: رجّع الرسالة والزرار الأصليين زي ما كانوا، من غير أي حذف ---
  if (rawAction === 'delexp_no' || rawAction === 'deldebt_no' || rawAction === 'delinv_no') {
    const baseAction = rawAction.replace('_no', '');
    const cleanText = originalText.replace(/\n\n⚠️ متأكد إنك عايز تمسح العملية دي؟$/, '');
    await answerCallbackQuery(callbackQuery.id, 'اتلغى، العملية لسه موجودة');
    await editTelegramMessage(chatId, messageId, cleanText, 'HTML', buildDeleteMarkup(baseAction, id));
    return;
  }

  // --- تأكيد فعلي: هنا بس بيتم المسح من قاعدة البيانات ---
  if (rawAction === 'delexp_yes') {
    const deleted = await deleteExpenseById(id, userId);
    if (!deleted) {
      await answerCallbackQuery(callbackQuery.id, '❌ العملية دي اتمسحت قبل كده أو مش لاقيها.', true);
      return;
    }
    await answerCallbackQuery(callbackQuery.id, '🗑 اتمسح');
    await editTelegramMessage(chatId, messageId, `🗑 <s>اتمسح مصروف ${deleted.category} · ${deleted.amount} جنيه</s>`, 'HTML');
    return;
  }

  if (rawAction === 'deldebt_yes') {
    const deleted = await deleteDebtById(id, userId);
    if (!deleted) {
      await answerCallbackQuery(callbackQuery.id, '❌ العملية دي اتمسحت قبل كده أو مش لاقيها.', true);
      return;
    }
    await answerCallbackQuery(callbackQuery.id, '🗑 اتمسح');
    await editTelegramMessage(chatId, messageId, `🗑 <s>اتمسحت عملية ${deleted.person_name} · ${deleted.amount} جنيه</s>`, 'HTML');
    return;
  }

  if (rawAction === 'delinv_yes') {
    const deleted = await deleteInvoiceById(id, userId);
    if (!deleted) {
      await answerCallbackQuery(callbackQuery.id, '❌ الفاتورة دي اتمسحت قبل كده أو مش لاقيها.', true);
      return;
    }
    await answerCallbackQuery(callbackQuery.id, '🗑 اتمسحت');
    await editTelegramMessage(chatId, messageId, `🗑 <s>اتمسحت فاتورة ${deleted.merchant || ''} · ${deleted.total_amount} جنيه</s>`, 'HTML');
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
}

// ============ ميزة "امسح فاتورة" — بتاخد أعلى دقة متاحة من الصورة وتبعتها لـ Groq Vision، وتسجل النتيجة كمصروف عادي ============
// usage: نتيجة checkOcrUsage الجاهزة (اتفحصت واتزادت قبل النداء على الدالة دي) — بتستخدم بس عشان نعرض
// عداد صغير "المتبقي: x/y" في نهاية رسالة التأكيد للمشترك (مش للتجربة المجانية، عشان تحس إنها Unlimited).
async function handleReceiptPhoto(message, userId, chatId, usage) {
  await sendChatAction(chatId, 'typing');
  await sendTelegramMessage(chatId, '📸 بقرا الفاتورة وبفصّل كل صنف فيها...');

  // تليجرام بيبعت الصورة بأكتر من دقة — بناخد آخر عنصر (أعلى دقة)
  const bestPhoto = message.photo[message.photo.length - 1];
  const receipt = await extractItemizedReceiptFromImage(bestPhoto.file_id);

  if (!receipt.success) {
    // القراءة فشلت — مش غلطة المستخدم، فبنرجّعله المحاولة اللي اتخصمت من عداده قبل النداء على Groq
    await refundOcrUsage(userId);

    const hintLine = receipt.hint
      ? `\n\n🔍 اللي واخد بالي منه: ${receipt.hint}. جرب تصورها تاني بحيث الجزء ده يبقى واضح.`
      : '';
    await sendTelegramMessage(
      chatId,
      `😕 مقدرتش أقرا الفاتورة دي كويس حتى بعد ما حاولت أكتر من مرة.${hintLine}\nجرب تصورها تاني بإضاءة أحسن وبدون قص لأي جزء، أو ابعت المصروف كنص عادي زي "صرفت 150 جنيه سوبر ماركت".\n\n↩️ محاولة الفاتورة دي مترجعتلك، متتخصمش من عدادك.`
    );
    return;
  }

  const footer = usage && !usage.isTrial && usage.remaining !== null
    ? `📎 <i>المتبقي: ${usage.remaining}/${usage.limit} فاتورة الشهر ده</i>`
    : '';
  await recordInvoice(receipt, userId, chatId, footer);
}

// ============ نقطة الدخول - Vercel بينادي الدالة دي لكل ريكوست ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  // --- تحقق من إن الطلب فعلاً جاي من تليجرام مش من حد مزوّر ---
  // لو TELEGRAM_WEBHOOK_SECRET متظبط في Environment Variables، لازم كل طلب يجيله بنفس السر
  // في هيدر X-Telegram-Bot-Api-Secret-Token (تليجرام بيبعته أوتوماتيك بعد ما تضبطه في setWebhook).
  if (TELEGRAM_WEBHOOK_SECRET) {
    const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (incomingSecret !== TELEGRAM_WEBHOOK_SECRET) {
      console.error('Webhook: secret token mismatch — طلب مرفوض');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  try {
    const update = req.body;

    // --- ضغطة على زرار "🗑 حذف" تحت رسالة تسجيل مصروف/دين ---
    if (update.callback_query) {
      await handleDeleteCallback(update.callback_query);
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
    // --- صورة: إما فاتورة/إيصال (ميزة "امسح فاتورة" لمشترك فعّال أو في التجربة) أو سكرين شوت تحويل اشتراك ---
    // بنفرّق بينهم بالحالة: لو عنده اشتراك فعّال أو لسه في التجربة، وما كتبش كلمة بتدل على نية دفع
    // في الكابشن (زي "اشتراك"/"دفعت"/"انستاباي")، بنعتبرها فاتورة عايز يسجلها. غير كده تعتبر إيصال دفع.
    if (message.photo) {
      const caption = message.caption ? message.caption.trim() : '';
      const looksLikePaymentProof = /اشتراك|دفعت|فيزا|انستاباي|إنستاباي|instapay/i.test(caption);

      const activeNow = await hasActiveSubscription(userId);
      const trialNow = activeNow ? false : await isInTrial(userId);

      if ((activeNow || trialNow) && !looksLikePaymentProof) {
        const usage = await checkOcrUsage(userId);
        if (!usage.allowed) {
          if (usage.isTrial) {
            // خلّص حدود التجربة المجانية للفواتير — بنعامله زي ما لو التجربة خلصت (بيوجّهه للاشتراك)
            await sendTrialEndedPrompt(chatId, userId);
          } else {
            await sendTelegramMessage(
              chatId,
              '📸 وصلت للحد الأقصى من "امسح فاتورة" الشهر ده.\nتقدر تسجل المصروف بنص عادي زي "صرفت 150 جنيه سوبر ماركت" لحد ما العداد يرجع تاني بداية الشهر الجاي.'
            );
          }
          return res.status(200).json({ ok: true });
        }
        await handleReceiptPhoto(message, userId, chatId, usage);
        return res.status(200).json({ ok: true });
      }

      const senderName = caption;

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
        if (expiresAt) {
          await sendTelegramMessage(chatId, buildSubscriptionPrompt(true, true), 'HTML');
        } else {
          await sendTrialEndedPrompt(chatId, userId);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // --- البوابة: أي استخدام تاني للبوت (صوت، مصروف، تقرير، إلخ) محتاج اشتراك فعّال أو تجربة مجانية شغالة ---
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      const inTrial = await isInTrial(userId);
      if (!inTrial) {
        const expiresAt = await getSubscriptionExpiry(userId);
        if (expiresAt) {
          await sendTelegramMessage(chatId, buildSubscriptionPrompt(true, true), 'HTML');
        } else {
          await sendTrialEndedPrompt(chatId, userId);
        }
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
      // مدة الفويس محدودة (تكلفة التفريغ عند Groq بتتحسب على المدة) — بنرفض بلطف من غير ما نستهلك عداد
      if ((message.voice.duration || 0) > VOICE_MAX_DURATION_SECONDS) {
        await sendTelegramMessage(
          chatId,
          `🎙️ الفويس أطول من ${VOICE_MAX_DURATION_SECONDS} ثانية. ابعته أقصر أو قسّمه لأكتر من فويس، أو اكتب رسالة نصية عادي.`
        );
        return res.status(200).json({ ok: true });
      }

      // الفويس بيظهر للمستخدم زي "Unlimited" دايمًا (مفيش عداد ظاهر خالص)، الحد بيتفحص خفي في الباك إند بس
      const usage = await checkVoiceUsage(userId);
      if (!usage.allowed) {
        if (usage.isTrial) {
          await sendTrialEndedPrompt(chatId, userId);
        } else {
          // رسالة عامة من غير أي أرقام أو تلميح لحد شهري، عشان الميزة تفضل حاسة إنها Unlimited
          await sendTelegramMessage(chatId, '🎙️ الخدمة الصوتية مشغولة عليك دلوقتي. اكتب رسالتك نصيًا وهسجلها لك زي المعتاد 🙏');
        }
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

  // أمر "فين فلوسي راحت؟" — ملخص الشهر بأسلوب Wrapped (أكبر تسريب + فرصة توفير + مقارنة)
  if (['حلل الشهر', 'فين فلوسي راحت', 'فين فلوسي راحت؟', 'wrapped', 'Wrapped', '/wrapped'].includes(text)) {
    await sendMonthlyWrapped(userId, chatId);
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

  // أمر "امسح آخر مصروف/عملية" — بديل سريع لزرار 🗑 لو مش قدامك رسالة التسجيل الأصلية أو مسحتها من الشات
  if (['امسح آخر مصروف', 'امسح اخر مصروف', 'امسح آخر عملية', 'امسح اخر عملية'].includes(text)) {
    await deleteLastExpense(userId, chatId);
    return;
  }
  if (['امسح آخر دين', 'امسح اخر دين'].includes(text)) {
    await deleteLastDebt(userId, chatId);
    return;
  }

  // ============ أوامر الأهداف المالية (Goals) ============
  // "هدفي 20000 لابتوب" أو "هدفي 20000 لابتوب خلال 60 يوم" → إنشاء هدف جديد
  const goalCreateMatch = text.match(/^هدفي\s+(\d+(?:\.\d+)?)\s*(?:جنيه|ج)?\s*(.*)$/);
  if (goalCreateMatch) {
    const targetAmount = parseFloat(goalCreateMatch[1]);
    let rest = goalCreateMatch[2].trim();
    let targetDate = null;

    const daysMatch = rest.match(/خلال\s+(\d+)\s*(?:يوم|أيام)/);
    if (daysMatch) {
      const days = parseInt(daysMatch[1], 10);
      const d = new Date();
      d.setDate(d.getDate() + days);
      targetDate = d.toISOString().slice(0, 10);
      rest = rest.replace(daysMatch[0], '').trim();
    }

    await createGoal({ title: rest || 'هدفك', targetAmount, targetDate }, userId, chatId);
    return;
  }

  // "هدفي" لوحدها → عرض حالة الهدف الحالي
  if (['هدفي', 'هدف', 'اهدافي', 'أهدافي', '/goal'].includes(text)) {
    await sendGoalStatus(userId, chatId);
    return;
  }

  // "وفرت 500" أو "ضيف على هدفي 500" → إضافة مبلغ موفّر على الهدف الحالي
  const contributeMatch = text.match(/^(?:وفرت|ضيف على هدفي|زود هدفي)\s+(\d+(?:\.\d+)?)/);
  if (contributeMatch) {
    await contributeToGoal(parseFloat(contributeMatch[1]), userId, chatId);
    return;
  }

  // إلغاء الهدف الحالي
  if (['احذف هدفي', 'الغاء هدفي', 'إلغاء هدفي', 'امسح هدفي'].includes(text)) {
    await cancelActiveGoal(userId, chatId);
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

  const parsedTransactions = (await classifyMessage(text)).map((item) => normalizeFinancialTransaction(item, text));
  let transactions = finalizeTransactions(correctExpenseMisclassifiedAsDebt(text, reconcileSingleTransaction(correctDebtDirections(text, parsedTransactions), text)));
  // fallback آمن للجمل الصوتية القصيرة مثل "غدا مية جنيه" إذا أعاد المصنّف unknown.
  if (!transactions.some((t) => (t?.type === 'expense' || t?.type === 'debt') && Number(t.amount) > 0)) {
    const deterministicExpense = extractDeterministicExpense(text);
    if (deterministicExpense) transactions = [{ ...deterministicExpense, displayLabel: deterministicExpense.category || deterministicExpense.note || 'مصروف' }];
  }
  let successCount = 0;
  const isBatch = transactions.length > 1; // فويس/رسالة فيها أكتر من معاملة — هنا بنجمع الرد بدل ما نبعت رسالة لكل بند

  // ============ مسار المعاملة الواحدة (الأغلبية العظمى من الرسائل): زي ما هو بالظبط —
  // رسالة تأكيد كاملة فورية مع زرار حذف، من غير أي تغيير في السلوك القديم. ============
  if (!isBatch) {
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
      } else if (isFinancialEventType(result.type) && result.amount) {
        const savedEvent = await recordFinancialEvent({ ...result, sourceText: text }, userId);
        if (savedEvent.ok) {
          await sendTelegramMessage(chatId, `✅ سجلت ${savedEvent.label} بقيمة ${savedEvent.record.amount} ${savedEvent.record.currency_code || 'EGP'}${result.item ? ` — ${result.item}` : ''}.`);
          successCount++;
        }
      }
    }
  } else {
    // ============ مسار كذا معاملة مع بعض (زي فويس "غدا 300 عشا 200 مواصلات 100 واصل لمحمد 500"):
    // كل بند بيتسجل في القاعدة *منفصل تمامًا* بالظبط زي مسار الرسالة الواحدة (الدقة والفصل في
    // البيانات مش بيتأثروا خالص)، لكن بدل ما كل بند يبعت رسالة تليجرام مستقلة (كان بيسبب "spam"
    // فعلي — 10 رسائل لفويس فيه 10 بنود)، بنجمع كل النتائج ونبعت رسالة واحدة مجمّعة بالفئة، زي
    // كارت "المعاملات الأخيرة" في تطبيقات زي Say، مع زرار حذف لكل بند لوحده تحت نفس الرسالة. ============
    const expenseResults = []; // { id, category, amount, moneyLabel, detail, isDuplicate }
    const debtResults = []; // { id, summary }
    let lastMoneyLabel = 'جنيه';
    let lastTodayTotal = null;
    let lastCurrency = 'EGP';

    for (const result of transactions) {
      if (result.type === 'expense' && result.amount) {
        const saved = await recordExpense(result, '', userId, chatId, '', { silent: true });
        if (saved) {
          expenseResults.push(saved);
          lastMoneyLabel = saved.moneyLabel;
          lastCurrency = saved.currency_code;
          lastTodayTotal = saved.todayTotal;
          successCount++;
        }
      } else if (result.type === 'debt' && result.amount && result.person) {
        const saved = await recordDebt(result, userId, chatId, { silent: true });
        if (saved) {
          debtResults.push(saved);
          successCount++;
        }
      } else if (result.type === 'settlement' && result.person) {
        await settleDebtWithPerson(result.person, userId, chatId);
        successCount++;
      } else if (isFinancialEventType(result.type) && result.amount) {
        const savedEvent = await recordFinancialEvent({ ...result, sourceText: text }, userId);
        if (savedEvent.ok) successCount++;
      }
    }

    if (expenseResults.length > 0 || debtResults.length > 0) {
      // تجميع المصاريف بالفئة (زي "أكل — 800 (غدا 300، عشا 200، كارفور 300)")، عشان الرسالة
      // تبقى مختصرة وواضحة بدل ما تكرر اسم الفئة في كل سطر لوحده.
      const byCategory = new Map();
      for (const e of expenseResults) {
        if (!byCategory.has(e.category)) byCategory.set(e.category, { total: 0, parts: [], hasDuplicate: false });
        const group = byCategory.get(e.category);
        group.total += Number(e.amount) || 0;
        group.parts.push(e.detail ? `${e.detail.replace(/^\s*\(|\)\s*$/g, '')} ${e.amount}` : `${e.amount}`);
        if (e.isDuplicate) group.hasDuplicate = true;
      }

      const lines = [];
      for (const [category, group] of byCategory) {
        const emoji = CATEGORY_EMOJI[category] || '📌';
        const breakdown = group.parts.length > 1 ? ` (${group.parts.join('، ')})` : '';
        const dupNote = group.hasDuplicate ? ' ⚠️' : '';
        lines.push(`${emoji} ${category} — ${group.total} ${lastMoneyLabel}${breakdown}${dupNote}`);
      }
      for (const d of debtResults) {
        lines.push(d.summary);
      }

      let msg = `✅ <b>سجلت ${successCount} معاملة</b>\n${lines.join('\n')}`;
      if (lastTodayTotal !== null) {
        msg += `\n\n💰 إجمالي صرفك النهاردة: <b>${lastTodayTotal} ${lastMoneyLabel}</b>`;
      }

      // زرار حذف لكل بند لوحده (مش رسالة منفصلة)، عشان لو بند غلط يتصلح من غير ما يمسح الباقي
      const deleteButtons = [
        ...expenseResults.map((e) => ({ text: `🗑 ${e.category} ${e.amount}`, callback_data: `delexp:${e.id}` })),
        ...debtResults.map((d) => ({ text: '🗑 دين', callback_data: `deldebt:${d.id}` })),
      ];
      const inline_keyboard = [];
      for (let i = 0; i < deleteButtons.length; i += 2) inline_keyboard.push(deleteButtons.slice(i, i + 2));

      await sendTelegramMessage(chatId, msg, 'HTML', inline_keyboard.length ? { inline_keyboard } : undefined);
    }
  }

  if (successCount === 0) {
    // --- قبل ما نقول "معرفتش أفهم"، نجرب نشوف لو الرسالة سؤال عن بياناته (زي "صرفت كام على الأكل؟") ---
    const answered = await tryAnswerAsDataQuestion(text, userId, chatId);
    if (!answered) {
      await sendTelegramMessage(
        chatId,
        'مش قادر أحدد المعاملات من رسالتك 🤔\nجرب تبعت زي كده: "صرفت 50 جنيه أكل" أو "عطيت محمد 200 جنيه" أو "خلصت مع محمد"'
      );
    }
  }
}

// ============ حذف آخر مصروف/دين عن طريق أمر نصي (بديل سريع لزرار 🗑 تحت رسالة التسجيل) ============
// برضو بيطلب تأكيد قبل ما يمسح فعليًا — نفس مبدأ زرار 🗑، بس بيبدأ من رسالة تأكيد على طول
// (من غير الحاجة لخطوة "دوس حذف" الأولى، لأن الأمر النصي نفسه أصلاً نية واضحة للحذف).
async function deleteLastExpense(userId, chatId) {
  const latest = await getMostRecentExpense(userId);
  if (!latest) {
    await sendTelegramMessage(chatId, 'معندكش أي مصاريف مسجلة أصلاً عشان نمسحها 🤔');
    return;
  }
  await sendTelegramMessage(
    chatId,
    `⚠️ متأكد إنك عايز تمسح آخر مصروف: ${latest.category} · ${latest.amount} جنيه؟`,
    'HTML',
    buildConfirmMarkup('delexp', latest.id)
  );
}

async function deleteLastDebt(userId, chatId) {
  const latest = await getMostRecentDebt(userId);
  if (!latest) {
    await sendTelegramMessage(chatId, 'معندكش أي ديون مسجلة أصلاً عشان نمسحها 🤔');
    return;
  }
  await sendTelegramMessage(
    chatId,
    `⚠️ متأكد إنك عايز تمسح آخر عملية دين: ${latest.person_name} · ${latest.amount} جنيه؟`,
    'HTML',
    buildConfirmMarkup('deldebt', latest.id)
  );
}

// ============ لو الرسالة مش مصروف/دين واضح، نجرب نجاوب عليها كسؤال حر عن بيانات المستخدم ============
// (مثلاً: "صرفت كام على الأكل الشهر ده؟"، "مديون لمين؟"، "هل صرفي زاد؟"). لو Groq حس إنها مالهاش
// علاقة بالبيانات، بيرجع null وساعتها بنرجع لرسالة "معرفتش أفهم" العادية.
async function tryAnswerAsDataQuestion(text, userId, chatId) {
  try {
    // "المساعد الذكي" (الأسئلة الحرة عن البيانات) له حد شهري مستقل عن تسجيل المصاريف/الديون العادي
    const usage = await checkChatUsage(userId);
    if (!usage.allowed) {
      if (usage.isTrial) {
        await sendTrialEndedPrompt(chatId, userId);
      } else {
        await sendTelegramMessage(
          chatId,
          '💬 وصلت للحد الأقصى من أسئلة "دبّر" الذكي الشهر ده.\nتقدر لسه تستخدم الأوامر الجاهزة زي "تقرير" أو "ديون" عادي، والعداد هيرجع تاني بداية الشهر الجاي.'
        );
      }
      // اتعاملت الرسالة (برسالة حد/اشتراك)، فمنرجعش لرسالة "معرفتش أفهم" العادية
      return true;
    }

    const [expensesSummary, debtsSummary] = await Promise.all([
      getRecentExpensesSummaryText(userId),
      getDebtsSummaryText(userId),
    ]);
    const context = `${expensesSummary}\n\n${debtsSummary}`;
    const answer = await answerDataQuestion(text, context);
    if (!answer) return false;

    const footer = !usage.isTrial && usage.remaining !== null
      ? `\n\n<i>💬 المتبقي: ${usage.remaining}/${usage.limit}</i>`
      : '';
    await sendTelegramMessage(chatId, `💬 <b>دَبّر:</b>\n${answer}${footer}`, 'HTML');
    return true;
  } catch (err) {
    console.error('tryAnswerAsDataQuestion failed:', err);
    return false;
  }
}
