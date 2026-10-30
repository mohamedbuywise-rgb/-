import { supabase } from '../../lib/supabaseClient.js';
import { ADMIN_PASSWORD } from '../../lib/config.js';
import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';

// ============ /api/hekaya?action=... ============
// عام:
//   GET  action=current[&n=12]     → آخر عدد منشور (أو عدد برقمه) + تعليقاته + التفاعلات + الاستفتاء
//   GET  action=list               → أرشيف الأعداد المنشورة
// لازم تسجيل دخول:
//   POST action=comment            body: { issue_id, body, parent_id? }   (الرد على رد بيتحول لرد على الأصل)
//   POST action=comment_like       body: { comment_id }                   (toggle)
//   POST action=react              body: { issue_id, kind }               (toggle)
//   POST action=vote               body: { issue_id, option_index }       (صوت واحد لكل مستخدم)
// أدمن (Authorization: Bearer ADMIN_PASSWORD):
//   GET  action=admin_list
//   POST action=admin_save         body: { id?, issue_no, title, subtitle, article_md, video_url, cover_url, topic, week_start, poll_question, poll_options }
//   POST action=admin_publish      body: { id, publish: true|false }
//   POST action=admin_hide_comment body: { id, hidden: true|false }
//   POST action=admin_upload_cover body: { content_type, data_base64 }   → { url }

const KINDS = ['fire', 'think', 'money'];
const COVER_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const MEDIA_BUCKET = 'hekaya-media';

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
  const [cRes, rRes, vRes, mRes] = await Promise.all([
    supabase.from('hekaya_comments')
      .select('id, parent_id, author_name, body, created_at, user_id')
      .eq('issue_id', issue.id).eq('hidden', false).order('created_at', { ascending: true }),
    supabase.from('hekaya_reactions').select('kind').eq('issue_id', issue.id),
    supabase.from('hekaya_poll_votes').select('option_index, user_id').eq('issue_id', issue.id),
    userId
      ? supabase.from('hekaya_reactions').select('kind').eq('issue_id', issue.id).eq('user_id', userId)
      : Promise.resolve({ data: [] }),
  ]);

  const all = cRes.data || [];
  const ids = all.map((c) => c.id);
  let likeRows = [];
  if (ids.length) {
    const { data } = await supabase.from('hekaya_comment_likes').select('comment_id, user_id').in('comment_id', ids);
    likeRows = data || [];
  }
  const likeCount = {};
  const myLiked = new Set();
  likeRows.forEach((l) => {
    likeCount[l.comment_id] = (likeCount[l.comment_id] || 0) + 1;
    if (userId && l.user_id === userId) myLiked.add(l.comment_id);
  });

  const shaped = all.map((c) => ({
    id: c.id,
    parent_id: c.parent_id,
    author_name: c.author_name,
    body: c.body,
    created_at: c.created_at,
    is_mine: Boolean(userId) && c.user_id === userId,
    likes: likeCount[c.id] || 0,
    liked: myLiked.has(c.id),
  }));
  const top = shaped
    .filter((c) => !c.parent_id)
    .map((c) => ({ ...c, replies: shaped.filter((r) => r.parent_id === c.id) }));

  const counts = { fire: 0, think: 0, money: 0 };
  (rRes.data || []).forEach((r) => { if (counts[r.kind] !== undefined) counts[r.kind] += 1; });

  const options = Array.isArray(issue.poll_options) ? issue.poll_options : [];
  const pollCounts = options.map(() => 0);
  let myVote = null;
  (vRes.data || []).forEach((v) => {
    if (pollCounts[v.option_index] !== undefined) pollCounts[v.option_index] += 1;
    if (userId && v.user_id === userId) myVote = v.option_index;
  });

  const { poll_options, ...rest } = issue;
  return {
    ...rest,
    reactions: counts,
    myReactions: (mRes.data || []).map((r) => r.kind),
    comments: top,
    poll: options.length
      ? { question: issue.poll_question || 'رأيك إيه؟', options, counts: pollCounts, myVote }
      : null,
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

    let parentId = null;
    if (b.parent_id) {
      const { data: parent } = await supabase.from('hekaya_comments')
        .select('id, parent_id, issue_id, hidden').eq('id', b.parent_id).maybeSingle();
      if (!parent || parent.hidden || parent.issue_id !== b.issue_id) {
        return res.status(400).json({ ok: false, error: 'التعليق اللي بترد عليه مش موجود.' });
      }
      parentId = parent.parent_id || parent.id; // الردود بتفضل مستوى واحد
    }

    const { data, error } = await supabase.from('hekaya_comments').insert({
      issue_id: b.issue_id, parent_id: parentId, user_id: userId, author_name: name, body,
    }).select('id, parent_id, author_name, body, created_at').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, comment: { ...data, is_mine: true, likes: 0, liked: false, replies: [] } });
  }

  if (action === 'comment_like') {
    const commentId = String(b.comment_id || '');
    const { data: exists } = await supabase.from('hekaya_comments').select('id').eq('id', commentId).eq('hidden', false).maybeSingle();
    if (!exists) return res.status(404).json({ ok: false, error: 'التعليق مش موجود.' });
    const { data: existing } = await supabase.from('hekaya_comment_likes').select('comment_id')
      .eq('comment_id', commentId).eq('user_id', userId).maybeSingle();
    if (existing) {
      await supabase.from('hekaya_comment_likes').delete().eq('comment_id', commentId).eq('user_id', userId);
      return res.status(200).json({ ok: true, active: false });
    }
    const { error } = await supabase.from('hekaya_comment_likes').insert({ comment_id: commentId, user_id: userId });
    if (error) throw error;
    return res.status(200).json({ ok: true, active: true });
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
    const { error } = await supabase.from('hekaya_reactions').insert({ issue_id: b.issue_id, user_id: userId, kind });
    if (error) throw error;
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

  if (req.method === 'POST' && action === 'admin_upload_cover') {
    const type = String(b.content_type || '');
    const ext = COVER_TYPES[type];
    if (!ext) return res.status(400).json({ ok: false, error: 'الصورة لازم تكون JPG أو PNG أو WEBP.' });
    const buf = Buffer.from(String(b.data_base64 || ''), 'base64');
    if (!buf.length || buf.length > MAX_COVER_BYTES) return res.status(400).json({ ok: false, error: 'الصورة لازم تكون أقل من ٢ ميجا.' });
    const path = `covers/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, buf, { contentType: type, upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
    return res.status(200).json({ ok: true, url: data.publicUrl });
  }

  if (req.method === 'POST' && action === 'admin_save') {
    const opts = (Array.isArray(b.poll_options) ? b.poll_options : String(b.poll_options || '').split('\n'))
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
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
      poll_options: opts,
      updated_at: new Date().toISOString(),
    };
    if (!row.issue_no || !row.title) return res.status(400).json({ ok: false, error: 'رقم العدد والعنوان مطلوبين.' });
    if (b.video_url && !row.video_id) return res.status(400).json({ ok: false, error: 'رابط يوتيوب مش صحيح.' });
    if (opts.length && opts.length < 2) return res.status(400).json({ ok: false, error: 'الاستفتاء محتاج خيارين على الأقل.' });
    if (opts.length && !row.poll_question) return res.status(400).json({ ok: false, error: 'اكتب عنوان للاستفتاء.' });

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
