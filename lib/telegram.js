import { TELEGRAM_TOKEN } from './config.js';
import { deactivateUserByChatId } from './users.js';

// بتتنادى لما أي نداء لـ Telegram API يفشل. لو السبب 403 (المستخدم عمل Block للبوت أو مسح الشات)
// بنطفّي المستخدم ده في جدول users عشان الكرون يوقف يحاول يبعتله تاني كل يوم من غير داعي.
async function handleFailedTelegramCall(chatId, data, res) {
  if (data && data.error_code === 403) {
    await deactivateUserByChatId(chatId);
  } else {
    console.error('Telegram API error:', data || `HTTP ${res.status}`);
  }
}

// ============ إرسال رسالة نصية (بتدعم HTML formatting وأزرار اختيارية) ============
export async function sendTelegramMessage(chatId, text, parseMode, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    await handleFailedTelegramCall(chatId, data, res);
  }
  return data;
}

// ============ إرسال "بيكتب..." أو "بيبعت صورة..." — بنستخدمها وقت معالجة صورة الفاتورة عشان المستخدم يحس إن فيه شغل شغال ============
export async function sendChatAction(chatId, action = 'typing') {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // اختياري بالكامل — لو فشل مفيش أي تأثير على باقي الفلو
  }
}

// ============ إرسال صورة (للرسم البياني) ============
export async function sendTelegramPhoto(chatId, photoUrl, caption, parseMode) {
  const body = { chat_id: chatId, photo: photoUrl };
  if (caption) body.caption = caption;
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    await handleFailedTelegramCall(chatId, data, res);
    throw new Error(`sendPhoto failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ============ تعديل نص رسالة اتبعتت قبل كده (بنستخدمها لما نمسح عملية عن طريق زرار 🗑، عشان نبدّل نص الرسالة القديمة بتأكيد المسح) ============
export async function editTelegramMessage(chatId, messageId, text, parseMode, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    await handleFailedTelegramCall(chatId, data, res);
  }
  return data;
}

// ============ الرد السريع على ضغطة زرار (callback_query) — لازم يتنادى دايمًا وإلا تليجرام يفضل مورّي "بيحمّل..." على الزرار ============
export async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  if (showAlert) body.show_alert = true;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

// ============ تحويل (forward) رسالة زي ما هي لشات تاني — بنستخدمها لتحويل سكرين شوت الدفع للأدمن ============
export async function forwardTelegramMessage(toChatId, fromChatId, messageId) {
  const body = { chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId };

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    await handleFailedTelegramCall(toChatId, data, res);
  }
  return data;
}

// ============ إرسال ملف (CSV، PDF، ...إلخ) ============
export async function sendTelegramDocument(chatId, filename, content, caption, mimeType = 'text/csv;charset=utf-8') {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  if (caption) {
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
  }
  formData.append('document', new Blob([content], { type: mimeType }), filename);

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    await handleFailedTelegramCall(chatId, data, res);
    throw new Error(`sendDocument failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ============ قايمة أوامر البوت الرسمية — بتظهر لكل المستخدمين تلقائيًا جوه أيقونة "☰" جنب صندوق الكتابة ============
// إعداد على مستوى البوت كله (مش لكل مستخدم لوحده)، فبيتظبط مرة واحدة بس (عن طريق /api/setup)
export async function setBotCommands() {
  const commands = [
    { command: 'start', description: 'ابدأ استخدام دبّر' },
    { command: 'help', description: 'كل أوامر البوت وإزاي تستخدمها' },
    { command: 'report', description: 'التقرير الشهري' },
    { command: 'weekly', description: 'تقرير آخر 7 أيام' },
    { command: 'debts', description: 'ملخص كل الديون' },
    { command: 'export', description: 'تصدير بياناتك (CSV و TXT)' },
    { command: 'subscription', description: 'حالة اشتراكك' },
    { command: 'link', description: 'اربط حسابك بالداشبورد' },
  ];

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  return res.json();
}

// ============ زرار الدليل الثابت — بيظهر جنب صندوق الكتابة لأي حد يفتح الشات مع البوت، حتى أول مرة قبل ما يبعت أي رسالة ============
// لو عندك GUIDE_URL (صفحة الدليل) بيفتحها كـ Mini App بضغطة واحدة. لو مفيش، بيرجع القايمة الافتراضية "☰" العادية.
export async function setBotMenuButton(guideUrl) {
  const menuButton = guideUrl
    ? { type: 'web_app', text: '📖 الدليل', web_app: { url: guideUrl } }
    : { type: 'commands' };

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menu_button: menuButton }),
  });
  return res.json();
}
