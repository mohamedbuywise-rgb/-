package com.dabbar.smshelper

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** بيجيب ملخص الشهر من /api?route=widget-summary بنفس توكن ربط الحساب ويحدّث الويدجت. */
class WidgetSummaryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val token = try { SecurePrefs.getToken(applicationContext) } catch (e: Exception) { null }
        if (token.isNullOrBlank()) return Result.success() // لسه مفيش ربط: الويدجت بيعرض رسالة الربط
        return try {
            val url = URL("${BuildConfigValues.WEBHOOK_BASE_URL}/api?route=widget-summary")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            OutputStreamWriter(conn.outputStream).use { it.write(JSONObject().put("token", token).toString()) }
            val status = conn.responseCode
            if (status !in 200..299) { conn.disconnect(); return if (status in 400..499) Result.failure() else Result.retry() }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val json = JSONObject(body)
            val month = json.getJSONObject("month")
            val today = json.getJSONObject("today")
            WidgetCache.save(
                applicationContext, month.optString("label"), month.optLong("balance"), month.optLong("income"),
                month.optLong("expense"), today.optLong("expense"), today.optInt("count"),
            )
            DabbarSummaryWidgetProvider.renderAll(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val PERIODIC = "dabbar_widget_periodic"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        fun refreshNow(c: Context) {
            WorkManager.getInstance(c).enqueue(OneTimeWorkRequestBuilder<WidgetSummaryWorker>().setConstraints(online).build())
        }
        fun schedulePeriodic(c: Context) {
            val req = PeriodicWorkRequestBuilder<WidgetSummaryWorker>(30, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
        }
        fun cancelPeriodic(c: Context) { WorkManager.getInstance(c).cancelUniqueWork(PERIODIC) }
    }
}
