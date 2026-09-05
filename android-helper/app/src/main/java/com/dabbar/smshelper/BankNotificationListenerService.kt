package com.dabbar.smshelper

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * دبّر SMS Helper — Notification Listener
 *
 * بيسمع كل الإشعارات اللي بتوصل للجهاز (مش SMS نفسه)، ويفلتر بس اللي جاية من تطبيقات
 * رسائل معروفة (SMS/Messages) ونصها يطابق نمط بنك/محفظة مصرية معروفة. أي حاجة تانية
 * بيتجاهلها فورًا على الجهاز نفسه ومتتبعتش للسيرفر خالص (راجع ARCHITECTURE.md).
 *
 * يتفعّل من: Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS (إذن Notification Access).
 */
class BankNotificationListenerService : NotificationListenerService() {

    // أسماء الحزم (package names) الشائعة لتطبيقات الرسائل على أندرويد.
    // ملحوظة: لازم مراجعة/تحديث القايمة دي حسب أجهزة المستخدمين الفعلية (Samsung, Xiaomi...).
    private val messagingPackages = setOf(
        "com.google.android.apps.messaging", // Google Messages
        "com.samsung.android.messaging",     // Samsung Messages
        "com.android.mms",
        "com.miui.mishare.connectivity",     // بعض أجهزة Xiaomi بتبعت عبر تطبيقات مختلفة
        "com.xiaomi.mms",
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            if (sbn.packageName !in messagingPackages) return

            val extras = sbn.notification.extras
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            if (text.isBlank()) return

            // title في إشعار الـ SMS عادة هو اسم/رقم المرسل (Sender ID) — ده اللي بنطابقه
            // مع BankSenderMatcher بنفس منطق lib/bank-senders.js في الباك إند.
            val bankMatch = BankSenderMatcher.match(title)
            if (bankMatch == null) {
                Log.d(TAG, "تجاهل إشعار من مرسل غير معروف كبنك/محفظة: $title")
                return
            }

            val token = SecurePrefs.getToken(applicationContext) ?: run {
                Log.w(TAG, "لسه مفيش توكن مربوط — تجاهل الرسالة.")
                return
            }

            // الإرسال بيحصل عبر WorkManager (WebhookSendWorker) مش مباشرة هنا، عشان لو
            // النت مقطوع وقت وصول الرسالة، المحاولة تتعاد تلقائيًا لاحقًا من غير ما نفقد الرسالة.
            WebhookSendWorker.enqueue(
                context = applicationContext,
                token = token,
                sender = title,
                text = text,
            )
        } catch (e: Exception) {
            // أي استثناء هنا لازم يتبلع بهدوء — الخدمة دي بتشتغل system-wide، وأي crash
            // فيها ممكن يأثر على باقي إشعارات النظام عند بعض الشركات المصنعة.
            Log.e(TAG, "onNotificationPosted error", e)
        }
    }

    companion object {
        private const val TAG = "DabbarSmsHelper"
    }
}
