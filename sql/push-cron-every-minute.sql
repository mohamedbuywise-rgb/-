-- ============================================================================
-- جدولة الإشعارات كل دقيقة (عشان توصل في نفس الدقيقة اللي ضبطتها، زي رسايل البنك)
-- ----------------------------------------------------------------------------
-- ليه محتاجينه؟ Vercel (الخطة المجانية) بيشغّل الكرون مرتين في اليوم بس، فالتذكيرات كانت بتتأخر لحد ما ييجي الكرون.
-- الحل المجاني: Supabase pg_cron بينده /api/push-cron كل دقيقة، والسيرفر بيحسب وقت كل مستخدم بتوقيته الشخصي.
--
-- الخطوات (مرة واحدة):
-- 1) Supabase -> Database -> Extensions: فعّل pg_cron و pg_net.
-- 2) غيّر dabbar.online و 463b9f94a25b2ea8c49a7f77207e03ad8c3fe2bf81183557ced86448ce0844b4 تحت (نفس قيمة CRON_SECRET في Vercel Environment Variables).
-- 3) شغّل الملف في SQL Editor.
-- لمعرفة الحالة:   select * from cron.job;   وللإيقاف:   select cron.unschedule('dabbar-push-every-minute');
-- ============================================================================
select cron.schedule(
  'dabbar-push-every-minute',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://dabbar.online/api/push-cron',
    headers := jsonb_build_object('Authorization', 'Bearer 463b9f94a25b2ea8c49a7f77207e03ad8c3fe2bf81183557ced86448ce0844b4'),
    timeout_milliseconds := 20000
  );
  $$
);
