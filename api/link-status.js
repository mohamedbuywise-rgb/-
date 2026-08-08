import { supabase } from '../lib/supabaseClient.js';

// ============ GET /api/link-status ============
// بيتنادى من الداشبورد أول ما تفتح، عشان تعرف تعرض شاشة الربط أو تجيب البيانات الحقيقية على طول.
// Header: Authorization: Bearer <supabase access token>
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    }

    const { data } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    return res.status(200).json({ linked: Boolean(data) });
  } catch (err) {
    console.error('link-status error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع.' });
  }
}
