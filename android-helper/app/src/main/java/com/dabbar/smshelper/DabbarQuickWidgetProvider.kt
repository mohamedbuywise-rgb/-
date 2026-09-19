package com.dabbar.smshelper

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/** 4x1 دبّر widget with one-tap text and voice quick-entry actions. */
class DabbarQuickWidgetProvider : AppWidgetProvider() {
    private fun quickIntent(mode: String): Intent = Intent(
        Intent.ACTION_VIEW,
        Uri.parse("https://www.dabbar.online/app/dabbar-dashboard-full.html?quick=$mode")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    private fun pending(context: Context, mode: String, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode,
            quickIntent(mode),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_quick_entry).apply {
                setOnClickPendingIntent(R.id.widget_voice_button, pending(context, "voice", 4201 + id))
                setOnClickPendingIntent(R.id.widget_text_button, pending(context, "text", 4301 + id))
            }
            manager.updateAppWidget(id, views)
        }
    }
}
