import { setBotCommands, setBotMenuButton, setWebhookSecret } from '../../lib/telegram.js';
import { GUIDE_URL, SETUP_SECRET, TELEGRAM_WEBHOOK_SECRET } from '../../lib/config.js';

// ============ إعداد لمرة واحدة: بيثبت قايمة أوامر البوت + زرار الدليل + secret_token الويب هوك ============
// افتح الرابط ده مرة واحدة بس في المتصفح بعد كل ديبلوي (أو أول مرة بعد الرفع):
//   https://<your-vercel-domain>/api/setup?key=<SETUP_SECRET>
// الإعداد ده على مستوى البوت كله، مش لكل مستخدم، فمش محتاج تكرره غير لو غيّرت الأوامر أو الدومين.
//
// ⚠️ لازم تضبط SETUP_SECRET في Vercel Environment Variables، وإلا الـ endpoint هيرفض يشتغل —
// من غير كده أي حد يعرف الرابط يقدر يفتحه ويغيّر إعدادات البوت.
export default async function handler(req, res) {
  if (!SETUP_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'SETUP_SECRET مش متظبط في Environment Variables. ضيفه الأول عشان الـ endpoint ده يشتغل.',
    });
  }

  if (req.query.key !== SETUP_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const commandsResult = await setBotCommands();
    const menuButtonResult = await setBotMenuButton(GUIDE_URL);

    // ضبط الـ webhook بالسر عند تليجرام — لو محدد VERCEL_URL ومحدد TELEGRAM_WEBHOOK_SECRET.
    // لو عايز تحدد دومين مخصص بدل VERCEL_URL، أضف WEBHOOK_URL في الكود أو الـ env يدويًا.
    let webhookResult = null;
    if (TELEGRAM_WEBHOOK_SECRET && process.env.VERCEL_URL) {
      const webhookUrl = `https://${process.env.VERCEL_URL}/api/telegram-webhook`;
      webhookResult = await setWebhookSecret(webhookUrl, TELEGRAM_WEBHOOK_SECRET);
    }

    const ok = commandsResult.ok && menuButtonResult.ok && (webhookResult ? webhookResult.ok : true);

    return res.status(ok ? 200 : 500).json({
      ok,
      message: ok
        ? '✅ اتظبطت قايمة الأوامر وزرار الدليل والـ webhook. افتح البوت في تليجرام وشوف.'
        : '⚠️ حصلت مشكلة في جزء من الإعداد، شوف التفاصيل تحت.',
      commands: commandsResult,
      menuButton: menuButtonResult,
      webhook: webhookResult || '(TELEGRAM_WEBHOOK_SECRET أو VERCEL_URL مش متظبطين — الويب هوك متظبطش من هنا)',
      guideUrlUsed: GUIDE_URL || '(مفيش GUIDE_URL متظبط — الزرار هيرجع للقايمة الافتراضية ☰)',
    });
  } catch (err) {
    console.error('Setup error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
