import { supabase } from '../lib/supabaseClient.js';
import { getUserGlobalContext, updateUserGlobalContext } from '../lib/globalContext.js';
import { resolveDataUserId } from '../lib/authIdentity.js';

function getBearerToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
  }

  const { data: link, error: linkError } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (linkError) console.error('user-context user_links lookup error:', JSON.stringify(linkError));
  const dataUserId = link?.telegram_user_id || await resolveDataUserId(authData.user);
  if (!dataUserId) return res.status(500).json({ error: 'تعذر تجهيز إعدادات الحساب حاليًا.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ globalContext: await getUserGlobalContext(dataUserId), telegramLinked: Boolean(link) });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const allowed = ['country', 'countryCode', 'language', 'currency', 'currencyCode', 'locale', 'timezone'];
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'مفيش إعدادات صالحة للتحديث.' });

    const context = await updateUserGlobalContext(dataUserId, patch);
    return res.status(200).json({ globalContext: context });
  } catch (error) {
    console.error('user-context update error:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حفظ الإعدادات حاليًا.' });
  }
}
