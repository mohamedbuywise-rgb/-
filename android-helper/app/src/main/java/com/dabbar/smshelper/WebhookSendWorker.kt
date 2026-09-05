package com.dabbar.smshelper

import android.content.Context
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.Constraints
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * بيبعت { token, sender, text } لـ POST /api/sms-webhook — نفس الـ contract اللي
 * MacroDroid بيستخدمه دلوقتي (راجع backend/api-handlers/sms-webhook.js)، فمفيش أي
 * تغيير مطلوب في الباك إند عشان الـ APK ده يشتغل.
 *
 * WorkManager بيتكفل بإعادة المحاولة تلقائيًا لو النت مقطوع وقت وصول الرسالة (Constraints
 * بتستنى اتصال إنترنت متاح)، فمفيش رسالة بتضيع.
 */
class WebhookSendWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val token = inputData.getString(KEY_TOKEN) ?: return Result.failure()
        val sender = inputData.getString(KEY_SENDER).orEmpty()
        val text = inputData.getString(KEY_TEXT) ?: return Result.failure()

        return try {
            val body = JSONObject().apply {
                put("token", token)
                put("sender", sender)
                put("text", text)
            }

            val url = URL("${BuildConfigValues.WEBHOOK_BASE_URL}/api/sms-webhook")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
            }

            OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }

            val status = connection.responseCode
            connection.disconnect()

            when {
                status in 200..299 -> Result.success()
                // 4xx (توكن غلط، مرسل غير معروف...) — مفيش داعي نعيد المحاولة، الخطأ في البيانات نفسها.
                status in 400..499 -> Result.failure()
                // 5xx / أي حاجة تانية — ممكن تكون مشكلة مؤقتة في السيرفر، نعيد المحاولة.
                else -> Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val KEY_TOKEN = "token"
        private const val KEY_SENDER = "sender"
        private const val KEY_TEXT = "text"

        fun enqueue(context: Context, token: String, sender: String, text: String) {
            val data = Data.Builder()
                .putString(KEY_TOKEN, token)
                .putString(KEY_SENDER, sender)
                .putString(KEY_TEXT, text)
                .build()

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = OneTimeWorkRequestBuilder<WebhookSendWorker>()
                .setInputData(data)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueue(request)
        }
    }
}

/** نفس دومين دبّر المستخدم فعليًا في ملف الـ MacroDroid الحالي (assets/dabbar-sms-macro-template.macro). */
object BuildConfigValues {
    const val WEBHOOK_BASE_URL = "https://www.dabbar.online"
}
