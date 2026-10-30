import { supabase } from '../../lib/supabaseClient.js';
import { ADMIN_PASSWORD } from '../../lib/config.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

// ============ /api/hekaya?action=... ============
// عام (بدون تسجيل):
//   GET  action=current[&n=12]     → آخر عدد منشور (أو عدد برقمه) + تعليقاته + التفاعلات
//   GET  action=list               → أرشيف الأعداد المنشورة
// لازم تسجيل دخول (داشبورد):
//   POST action=comment            body: { issue_id, body, parent_id? }
//   POST action=react              body: { issue_id, kind }   (toggle)
//   POST action=vote               body: { issue_id, option_index }   (صوت واحد لكل مستخدم)
// أدمن (Authorization: Bearer ADMIN_PASSWORD):
//   GET  action=admin_list
//   POST action=admin_save         body: { id?, issue_no, title, subtitle, article_md, video_url, cover_url, topic, week_start }
//   POST action=admin_publish      body: { id, publish: true|false }
//   POST action=admin_hide_comment body: { id, hidden: true|false }

const KINDS = ['fire', 'think', 'money'];

export function extractYouTubeId(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  return Boolean(token) && token === ADMIN_PASSWORD;
}

async function loadIssueWithSocial(issue, userId = null) {
  const [{ data: comments }, { data: reactions }, { data: votes }, { data: mine }] = await Promise.all([
    supabase.from('hekaya_comments')
      .select('id, parent_id, author_name, body, created_at')
      .eq('issue_id', issue.id).eq('hidden', false).order('created_at', { ascending: true }),
    supabase.from('hekaya_reactions').select('kind').eq('issue_id', issue.id),
    supabase.from('hekaya_poll_votes').select('option_index').eq('issue_id', issue.id),
    userId
      ? supabase.from('hekaya_reactions').select('kind').eq('issue_id', issue.id).eq('user_id', userId)
      : Promise.resolve({ data: [] }),
  ]);
  const counts = { fire: 0, think: 0, money: 0 };
  (reactions || []).forEach((r) => { if (counts[r.kind] !== undefined) counts[r.kind] += 1; });
  const all = comments || [];
  const top = all.filter((c) => !c.parent_id).map((c) => ({ ...c, replies: all.filter((r) => r.parent_id === c.id) }));
  const options = Array.isArray(issue.poll_options) ? issue.poll_options : [];
  const pollCounts = options.map(() => 0);
  (votes || []).forEach((v) => { if (pollCounts[v.option_index] !== undefined) pollCounts[v.option_index] += 1; });
  const myReactions = (mine || []).map((r) => r.kind);
  let myVote = null;
  if (userId) {
    const { data: vote } = await supabase.from('hekaya_poll_votes').select('option_index')
      .eq('issue_id', issue.id).eq('user_id', userId).maybeSingle();
    myVote = vote ? vote.option_index : null;
  }
  const { poll_options, ...rest } = issue;
  return {
    ...rest,
    reactions: counts,
    myReactions,
    comments: top,
    poll: options.length ? { question: issue.poll_question || '', options, counts: pollCounts, myVote } : null,
  };
}

const PUBLIC_FIELDS = 'id, issue_no, title, subtitle, article_md, video_id, video_url, cover_url, topic, week_start, published_at, poll_question, poll_options';

async function handleGetPublic(req, res) {
  const action = req.query.action;
  if (action === 'list') {
    const { data, error } = await supabase.from('hekaya_issues')
      .select('id, issue_no, title, subtitle, cover_url, topic, published_at')
      .eq('status', 'published').order('issue_no', { ascending: false }).limit(50);
    if (error) throw error;
    return res.status(200).json({ ok: true, issues: data || [] });
  }
  if (action === 'current') {
    let q = supabase.from('hekaya_issues').select(PUBLIC_FIELDS).eq('status', 'published');
    if (req.query.n) q = q.eq('issue_no', Number(req.query.n));
    else q = q.order('issue_no', { ascending: false }).limit(1);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) return res.status(200).json({ ok: true, issue: null });
    const session = await getDashboardUserFromRequest(req).catch(() => null);
    return res.status(200).json({ ok: true, issue: await loadIssueWithSocial(data, session?.user?.id || null) });
  }
  return res.status(400).json({ ok: false, error: 'action غير معروف' });
}

async function handlePostUser(req, res) {
  const action = req.query.action;
  const session = await getDashboardUserFromRequest(req);
  if (!session?.user) return res.status(401).json({ ok: false, error: 'لازم تسجل دخول الأول.' });
  const userId = session.user.id;
  const name = (session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'مستخدم').slice(0, 40);
  const b = req.body || {};

  if (action === 'comment') {
    const body = String(b.body || '').trim();
    if (body.length < 1 || body.length > 500) return res.status(400).json({ ok: false, error: 'التعليق لازم يكون بين حرف و٥٠٠ حرف.' });
    const { data, error } = await supabase.from('hekaya_comments').insert({
      issue_id: b.issue_id, parent_id: b.parent_id || null, user_id: userId, author_name: name, body,
    }).select('id, parent_id, author_name, body, created_at').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, comment: data });
  }

  if (action === 'vote') {
    const idx = Number(b.option_index);
    const { data: issue } = await supabase.from('hekaya_issues').select('poll_options, status').eq('id', b.issue_id).maybeSingle();
    if (!issue || issue.status !== 'published') return res.status(404).json({ ok: false, error: 'العدد مش موجود.' });
    const opts = Array.isArray(issue.poll_options) ? issue.poll_options : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) return res.status(400).json({ ok: false, error: 'اختيار غير صحيح.' });
    const { error } = await supabase.from('hekaya_poll_votes').insert({ issue_id: b.issue_id, user_id: userId, option_index: idx });
    if (error) {
      if (String(error.message || '').includes('duplicate')) return res.status(409).json({ ok: false, error: 'صوتت قبل كده.' });
      throw error;
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'react') {
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ ok: false, error: 'تفاعل غير معروف' });
    const { data: existing } = await supabase.from('hekaya_reactions').select('kind')
      .eq('issue_id', b.issue_id).eq('user_id', userId).eq('kind', kind).maybeSingle();
    if (existing) {
      await supabase.from('hekaya_reactions').delete().eq('issue_id', b.issue_id).eq('user_id', userId).eq('kind', kind);
      return res.status(200).json({ ok: true, active: false });
    }
    await supabase.from('hekaya_reactions').insert({ issue_id: b.issue_id, user_id: userId, kind });
    return res.status(200).json({ ok: true, active: true });
  }
  return res.status(400).json({ ok: false, error: 'action غير معروف' });
}

async function handleAdmin(req, res) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD مش متضاف على Vercel.' });
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'الصفحة دي للأدمن بس.' });
  const action = req.query.action;
  const b = req.body || {};

  if (req.method === 'GET' && action === 'admin_list') {
    const { data, error } = await supabase.from('hekaya_issues')
      .select('id, issue_no, title, subtitle, article_md, video_url, cover_url, topic, status, published_at, week_start, poll_question, poll_options')
      .order('issue_no', { ascending: false }).limit(100);
    if (error) throw error;
    return res.status(200).json({ ok: true, issues: data || [] });
  }

  if (req.method === 'POST' && action === 'admin_save') {
    const row = {
      issue_no: Number(b.issue_no),
      title: String(b.title || '').trim(),
      subtitle: String(b.subtitle || '').trim() || null,
      article_md: String(b.article_md || ''),
      video_url: String(b.video_url || '').trim() || null,
      video_id: extractYouTubeId(b.video_url),
      cover_url: String(b.cover_url || '').trim() || null,
      topic: String(b.topic || '').trim() || null,
      week_start: b.week_start || null,
      poll_question: String(b.poll_question || '').trim() || null,
      poll_options: (Array.isArray(b.poll_options) ? b.poll_options : String(b.poll_options || '').split('\n'))
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6),
      updated_at: new Date().toISOString(),
    };
    if (!row.issue_no || !row.title) return res.status(400).json({ ok: false, error: 'رقم العدد والعنوان مطلوبين.' });
    if (b.video_url && !row.video_id) return res.status(400).json({ ok: false, error: 'رابط يوتيوب مش صحيح.' });
    const q = b.id
      ? supabase.from('hekaya_issues').update(row).eq('id', b.id).select('id').single()
      : supabase.from('hekaya_issues').insert({ ...row, status: 'draft' }).select('id').single();
    const { data, error } = await q;
    if (error) return res.status(400).json({ ok: false, error: error.message.includes('duplicate') ? 'رقم العدد ده موجود قبل كده.' : error.message });
    return res.status(200).json({ ok: true, id: data.id });
  }

  if (req.method === 'POST' && action === 'admin_publish') {
    const publish = b.publish !== false;
    const { error } = await supabase.from('hekaya_issues')
      .update({ status: publish ? 'published' : 'draft', published_at: publish ? new Date().toISOString() : null })
      .eq('id', b.id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST' && action === 'admin_hide_comment') {
    const { error } = await supabase.from('hekaya_comments').update({ hidden: Boolean(b.hidden) }).eq('id', b.id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}

export default async function handler(req, res) {
  try {
    const action = String(req.query.action || '');
    if (action.startsWith('admin_')) return await handleAdmin(req, res);
    if (req.method === 'GET') return await handleGetPublic(req, res);
    if (req.method === 'POST') return await handlePostUser(req, res);
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('hekaya error:', err);
    return res.status(500).json({ ok: false, error: 'حصل خطأ غير متوقع، جرب تاني.' });
  }
}
