package com.dabbar.smshelper

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * تخزين آمن للتوكن الخاص بالمستخدم (androidx.security-crypto) — بدل SharedPreferences
 * عادي، عشان التوكن مايتقراش بسهولة من جهاز مفتوح (root/adb backup).
 */
object SecurePrefs {
    private const val FILE_NAME = "dabbar_secure_prefs"
    private const val KEY_TOKEN = "sms_webhook_token"

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        FILE_NAME,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun getToken(context: Context): String? = prefs(context).getString(KEY_TOKEN, null)

    fun setToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun clearToken(context: Context) {
        prefs(context).edit().remove(KEY_TOKEN).apply()
    }
}
