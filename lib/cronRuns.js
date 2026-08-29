import { supabase } from './supabaseClient.js';

// ============ بيحاول "يحجز" إن التقرير ده اتبعت للمستخدم ده في الفترة دي ============
// لو رجّعت true: أول مرة، كمّل ابعت التقرير عادي.
// لو رجّعت false: اتبعت قبل كده لنفس الفترة (يا إما الكرون اشتغل مرتين، يا إما تشغيل يدوي بالغلط) — متبعتوش تاني.
//
// ملحوظة: الدالة دي للاستخدام جوه الكرون بس، مش جوه دوال التقارير المشتركة (sendWeeklyReport / sendMonthlyReport)،
// عشان لو المستخدم طلب تقرير يدوي بنفسه من الشات، يفضل يقدر ياخده في أي وقت من غير ما الحجز يمنعه.
export async function claimCronSlot(userId, reportType, periodKey) {
  const { error } = await supabase
    .from('cron_runs')
    .insert({ telegram_user_id: userId, report_type: reportType, period_key: periodKey });

  if (error) {
    // كود 23505 = unique violation (Postgres) يعني الحجز ده اتاخد قبل كده — مش خطأ حقيقي
    if (error.code === '23505') return false;
    console.error('claimCronSlot error:', error);
    return false; // في حالة شك، الأفضل نتخطى بدل ما نكرر إرسال
  }
  return true;
}
