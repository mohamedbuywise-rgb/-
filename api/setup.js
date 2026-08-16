import { setBotCommands, setBotMenuButton } from '../lib/telegram.js';
import { GUIDE_URL } from '../lib/config.js';

// ============ إعداد لمرة واحدة: بيثبت قايمة أوامر البوت + زرار الدليل الثابت جنب صندوق الكتابة ============
// افتح الرابط ده مرة واحدة بس في المتصفح بعد كل ديبلوي (أو أول مرة بعد الرفع):
//   https://<your-vercel-domain>/api/setup
// الإعداد ده على مستوى البوت كله، مش لكل مستخدم، فمش محتاج تكرره غير لو غيّرت الأوامر أو الدومين.
export default async function handler(req, res) {
  try {
    const commandsResult = await setBotCommands();
    const menuButtonResult = await setBotMenuButton(GUIDE_URL);

    const ok = commandsResult.ok && menuButtonResult.ok;

    return res.status(ok ? 200 : 500).json({
      ok,
      message: ok
        ? '✅ اتظبطت قايمة الأوامر وزرار الدليل. افتح البوت في تليجرام وشوف.'
        : '⚠️ حصلت مشكلة في جزء من الإعداد، شوف التفاصيل تحت.',
      commands: commandsResult,
      menuButton: menuButtonResult,
      guideUrlUsed: GUIDE_URL || '(مفيش GUIDE_URL متظبط — الزرار هيرجع للقايمة الافتراضية ☰)',
    });
  } catch (err) {
    console.error('Setup error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
