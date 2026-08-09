import { supabase } from '../lib/supabaseClient.js';
import { computeNetByPerson } from '../lib/debts.js';
import { buildFullDebtReportHtml } from '../lib/debtReportTemplate.js';
import { renderPdfFromHtml } from '../lib/pdf.js';

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

    const { data: link } = await supabase
      .from('user_links')
      .select('telegram_user_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (!link) {
      return res.status(400).json({ error: 'لازم تربط حسابك بالبوت الأول.' });
    }

    const netByPerson = await computeNetByPerson(link.telegram_user_id);
    const entries = Object.values(netByPerson).filter((v) => v.net !== 0);

    if (entries.length === 0) {
      return res.status(404).json({ error: 'معندكش ديون مستحقة حالياً.' });
    }

    const owedToYou = entries.filter((v) => v.net > 0).sort((a, b) => b.net - a.net);
    const youOwe = entries.filter((v) => v.net < 0).sort((a, b) => a.net - b.net);
    const totalOwedToYou = owedToYou.reduce((sum, v) => sum + v.net, 0);
    const totalYouOwe = youOwe.reduce((sum, v) => sum + Math.abs(v.net), 0);
    const net = totalOwedToYou - totalYouOwe;

    const html = buildFullDebtReportHtml({
      userName: userData.user.email, // أو أي اسم متاح
      owedToYou,
      youOwe,
      totalOwedToYou,
      totalYouOwe,
      net,
      generatedAt: new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
    });

    const pdfBuffer = await renderPdfFromHtml(html);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="كشف-الديون-الشامل.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('debts-report-pdf error:', err);
    return res.status(500).json({ error: 'حصل خطأ في توليد الملف، جرب تاني.' });
  }
}
