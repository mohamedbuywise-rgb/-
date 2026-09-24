package com.dabbar.smshelper

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/** ويدجت دبّر 4x2: المتبقي هذا الشهر (رقم كبير) + شريط نسبة الصرف من الدخل + مصروف اليوم + إضافة مصروف/دخل/صوت بضغطة. */
class DabbarSummaryWidgetProvider : AppWidgetProvider() {

    override fun onEnabled(context: Context) {
        WidgetSummaryWorker.schedulePeriodic(context)
        WidgetSummaryWorker.refreshNow(context)
    }

    override fun onDisabled(context: Context) = WidgetSummaryWorker.cancelPeriodic(context)

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        renderAll(context)
        WidgetSummaryWorker.refreshNow(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) WidgetSummaryWorker.refreshNow(context)
    }

    companion object {
        const val ACTION_REFRESH = "com.dabbar.smshelper.WIDGET_REFRESH"
        private const val BASE = "https://www.dabbar.online/app/dabbar-dashboard-full.html"

        private fun link(context: Context, mode: String, code: Int): PendingIntent = PendingIntent.getActivity(
            context, code,
            Intent(Intent.ACTION_VIEW, Uri.parse("$BASE?quick=$mode")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun renderAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, DabbarSummaryWidgetProvider::class.java))
            ids.forEach { manager.updateAppWidget(it, build(context)) }
        }

        private fun build(context: Context): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_summary)
            val linked = try { !SecurePrefs.getToken(context).isNullOrBlank() } catch (e: Exception) { false }
            if (WidgetCache.hasData(context)) {
                val balance = WidgetCache.balance(context)
                val income = WidgetCache.income(context)
                val expense = WidgetCache.expense(context)
                v.setTextViewText(R.id.widget_month, WidgetCache.month(context))
                v.setTextViewText(R.id.widget_balance_label, if (balance < 0) "عجز هذا الشهر" else "المتبقي هذا الشهر")
                v.setTextViewText(R.id.widget_balance, (if (balance < 0) "-" else "") + WidgetCache.money(Math.abs(balance)))
                v.setTextColor(R.id.widget_balance, if (balance < 0) 0xFFFBBF24.toInt() else 0xFFF5FBF7.toInt())
                v.setTextViewText(R.id.widget_today, "اليوم −" + WidgetCache.money(WidgetCache.todayExpense(context)))
                v.setTextViewText(R.id.widget_income, "● دخل " + WidgetCache.money(income))
                v.setTextViewText(R.id.widget_expense, "● صرف " + WidgetCache.money(expense))
                val pct = if (income > 0) Math.min(100L, expense * 100 / income).toInt() else 0
                v.setProgressBar(R.id.widget_progress, 100, pct, false)
                v.setTextViewText(R.id.widget_percent, if (income > 0) "$pct٪ من الدخل" else "مفيش دخل مسجل")
            } else {
                v.setTextViewText(R.id.widget_month, "")
                v.setTextViewText(R.id.widget_balance_label, if (linked) "بنحمّل أرقامك..." else "اربط حسابك من تطبيق دبّر")
                v.setTextViewText(R.id.widget_balance, "—")
                v.setTextViewText(R.id.widget_today, "")
                v.setProgressBar(R.id.widget_progress, 100, 0, false)
            }
            v.setOnClickPendingIntent(R.id.widget_btn_expense, link(context, "expense", 4401))
            v.setOnClickPendingIntent(R.id.widget_btn_income, link(context, "income", 4402))
            v.setOnClickPendingIntent(R.id.widget_btn_voice, link(context, "voice", 4403))
            v.setOnClickPendingIntent(R.id.widget_header, link(context, "", 4404))
            v.setOnClickPendingIntent(
                R.id.widget_refresh,
                PendingIntent.getBroadcast(
                    context, 4405,
                    Intent(context, DabbarSummaryWidgetProvider::class.java).setAction(ACTION_REFRESH),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            return v
        }
    }
}
