import { CRON_SECRET } from '../../lib/config.js';
import { runPushSchedule } from '../../lib/pushSchedule.js';

// بيتنده كل 5 دقايق من scheduler خارجي (Supabase pg_cron أو cron-job.org):
//   GET https://YOUR-DOMAIN/api/push-cron   مع الهيدر   Authorization: Bearer <CRON_SECRET>
// في كل مرة بيبعت الإشعارات اللي حان وقتها لكل مستخدم حسب وقته وتوقيته المحلي.
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const summary = await runPushSchedule();
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    console.error('push-cron failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}
