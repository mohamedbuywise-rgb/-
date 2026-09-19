package com.dabbar.smshelper

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * شاشة إعداد واحدة بس:
 * 1) استقبال التوكن (من رابط عميق dabbar://setup?token=... جاي من المتصفح، أو لصق يدوي).
 * 2) زرار يودّي المستخدم لصفحة Notification Access في إعدادات النظام (إذن يتاخد مرة واحدة).
 * بعد كده التطبيق شغال بالكامل في الخلفية — مفيش شاشات تانية يحتاجها المستخدم.
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val tokenInput = findViewById<EditText>(R.id.tokenInput)
        val statusText = findViewById<TextView>(R.id.statusText)
        val saveTokenBtn = findViewById<Button>(R.id.saveTokenBtn)
        val grantAccessBtn = findViewById<Button>(R.id.grantAccessBtn)

        // لو التطبيق اتفتح من رابط عميق dabbar://setup?token=XXXX (زرار "فعّل تتبع
        // رسائل البنك" في الداشبورد بيولّد اللينك ده)، نملأ الحقل أوتوماتيك.
        intent?.data?.getQueryParameter("token")?.let { tokenInput.setText(it) }

        saveTokenBtn.setOnClickListener {
            val token = tokenInput.text.toString().trim()
            if (token.isEmpty()) {
                Toast.makeText(this, "الصق التوكن الأول", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            SecurePrefs.setToken(this, token)
            Toast.makeText(this, "تم حفظ التوكن ✅", Toast.LENGTH_SHORT).show()
            updateStatus(statusText)
        }

        grantAccessBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        updateStatus(statusText)
    }

    override fun onResume() {
        super.onResume()
        updateStatus(findViewById(R.id.statusText))
    }

    private fun updateStatus(statusText: TextView) {
        val hasToken = SecurePrefs.getToken(this) != null
        val enabledListeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners").orEmpty()
        val hasAccess = enabledListeners.contains(packageName)

        statusText.text = when {
            hasToken && hasAccess -> "✅ دبّر شغال — هيسجّل رسائل البنك أوتوماتيك."
            !hasToken -> "1) الصق التوكن واحفظه."
            else -> "2) فعّل إذن الوصول للإشعارات عشان دبّر يشتغل."
        }
    }
}
