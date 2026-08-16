import { supabase } from '../lib/supabaseClient.js';
import { getRecentExpensesSummaryText } from '../lib/expenses.js';
import { getDebtsSummaryText } from '../lib/debts.js';
import { extractReceiptFromImageBase64, askDabbarChat } from '../lib/groq.js';
import { CATEGORIES } from '../lib/config.js';

// ============ Router: POST /api/assistant  { action: ... } ============
// كل ميزات "دبّر الذكي" الجديدة (الأهداف، امسح فاتورة، اسأل دبّر) اتلمّت هنا في endpoint واحد،
// بنفس فكرة api/reports.js — عشان نفضل تحت حد Vercel Hobby (12 function كحد أقصى) بدل ما نضيف
// ملف مستقل لكل ميزة.
//
// action = "goal_create"      { title, targetAmount, targetDate? }
// action = "goal_contribute"  { amount }
// action = "goal_cancel"      {}
// action = "receipt_scan"     { imageBase64, mimeType }
// action = "ask"              { question }

async function requireLink(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'لازم تسجل دخول الأول.' });
    return null;
  }

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخول تاني.' });
    return null;
  }

  const { data: link, error: linkError } = await supabase
    .from('user_links')
    .select('telegram_user_id')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (linkError) console.error('assistant user_links error:', JSON.stringify(linkError));

  if (!link) {
    res.status(400).json({ error: 'لازم تربط حسابك بالبوت الأول.' });
    return null;
  }

  return link.telegram_user_id;
}

function formatGoal(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    targetAmount: Number(row.target_amount),
    savedAmount: Number(row.saved_amount),
    targetDate: row.target_date,
    percent: Math.min(100, Math.round((Number(row.saved_amount) / Number(row.target_amount)) * 100)),
  };
}

async function handleGoalCreate(userId, body, res) {
  const title = (body.title || '').trim();
  const targetAmount = Number(body.targetAmount);
  const targetDate = body.targetDate || null;

  if (!title || !targetAmount || targetAmount <= 0) {
    return res.status(400).json({ error: 'محتاج اسم الهدف ومبلغ صحيح أكبر من صفر.' });
  }

  const { data: existing } = await supabase
    .from('goals')
    .select('id')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ error: 'عندك هدف شغال دلوقتي بالفعل. لازم تلغيه الأول عشان تبدأ هدف جديد.' });
  }

  const { data, error } = await supabase
    .from('goals')
    .insert({ telegram_user_id: userId, title, target_amount: targetAmount, saved_amount: 0, target_date: targetDate })
    .select('*')
    .single();

  if (error) {
    console.error('goal_create insert error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنسجل الهدف، جرب تاني.' });
  }

  return res.status(200).json({ goal: formatGoal(data) });
}

async function handleGoalContribute(userId, body, res) {
  const amount = Number(body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'محتاج مبلغ صحيح أكبر من صفر.' });
  }

  const { data: goal, error: fetchError } = await supabase
    .from('goals')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (fetchError) console.error('goal_contribute fetch error:', JSON.stringify(fetchError));
  if (!goal) return res.status(400).json({ error: 'معندكش هدف شغال دلوقتي.' });

  const newSaved = Number(goal.saved_amount) + amount;
  const achieved = newSaved >= Number(goal.target_amount);

  const { data: updated, error: updateError } = await supabase
    .from('goals')
    .update({ saved_amount: newSaved, is_active: achieved ? false : true, achieved_at: achieved ? new Date().toISOString() : null })
    .eq('id', goal.id)
    .select('*')
    .single();

  if (updateError) {
    console.error('goal_contribute update error:', JSON.stringify(updateError));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنحدّث هدفك، جرب تاني.' });
  }

  return res.status(200).json({ goal: formatGoal(updated), achieved });
}

async function handleGoalCancel(userId, res) {
  const { data: goal } = await supabase
    .from('goals')
    .select('id')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (!goal) return res.status(400).json({ error: 'معندكش هدف شغال أصلاً.' });

  const { error } = await supabase.from('goals').update({ is_active: false }).eq('id', goal.id);
  if (error) {
    console.error('goal_cancel error:', JSON.stringify(error));
    return res.status(500).json({ error: 'حصل خطأ وإحنا بنلغي الهدف، جرب تاني.' });
  }

  return res.status(200).json({ ok: true });
}

async function handleReceiptScan(userId, body, res) {
  const { imageBase64, mimeType } = body;
  if (!imageBase64) return res.status(400).json({ error: 'مفيش صورة اتبعتت.' });

  // بنشيل data:...;base64, لو المتصفح بعتها كاملة، Groq محتاج الـ base64 الخام بس
  const cleanBase64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '');

  const receipt = await extractReceiptFromImageBase64(cleanBase64, mimeType || 'image/jpeg');
  if (!receipt) {
    return res.status(422).json({ error: 'معرفتش أقرا الصورة دي. جرب صورة أوضح للإيصال أو الفاتورة.' });
  }

  const category = CATEGORIES.includes(receipt.category) ? receipt.category : CATEGORIES[0];
  const note = receipt.merchant ? `فاتورة ${receipt.merchant}` : 'فاتورة ممسوحة (من الداشبورد)';

  const { data: inserted, error } = await supabase
    .from('expenses')
    .insert({ telegram_user_id: userId, amount: receipt.amount, category, description: note })
    .select('id, amount, category, description, created_at')
    .single();

  if (error) {
    console.error('receipt_scan insert error:', JSON.stringify(error));
    return res.status(500).json({ error: 'قريت الفاتورة بس حصل خطأ وإحنا بنسجلها، جرب تاني.' });
  }

  return res.status(200).json({ expense: inserted, merchant: receipt.merchant || null });
}

async function handleAsk(userId, body, res) {
  const question = (body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب سؤالك الأول.' });
  if (question.length > 500) return res.status(400).json({ error: 'السؤال طويل أوي، اختصره شوية.' });

  const [expensesText, debtsText] = await Promise.all([
    getRecentExpensesSummaryText(userId),
    getDebtsSummaryText(userId),
  ]);

  const { data: goalRow } = await supabase
    .from('goals')
    .select('title, target_amount, saved_amount')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  const goalText = goalRow
    ? `هدفه المالي الحالي: ${goalRow.title} — وفّر ${Number(goalRow.saved_amount)} من ${Number(goalRow.target_amount)} جنيه.`
    : 'مفيش هدف مالي مسجل دلوقتي.';

  const dataContext = `${expensesText}\n\n${debtsText}\n\n${goalText}`;

  const answer = await askDabbarChat(question, dataContext);
  return res.status(200).json({ answer });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const userId = await requireLink(req, res);
    if (!userId) return; // requireLink already sent the error response

    const body = req.body || {};
    const action = body.action;

    switch (action) {
      case 'goal_create':
        return await handleGoalCreate(userId, body, res);
      case 'goal_contribute':
        return await handleGoalContribute(userId, body, res);
      case 'goal_cancel':
        return await handleGoalCancel(userId, res);
      case 'receipt_scan':
        return await handleReceiptScan(userId, body, res);
      case 'ask':
        return await handleAsk(userId, body, res);
      default:
        return res.status(400).json({ error: 'action غير معروف.' });
    }
  } catch (err) {
    console.error('assistant error:', err);
    return res.status(500).json({ error: 'حصل خطأ، جرب تاني.' });
  }
}
