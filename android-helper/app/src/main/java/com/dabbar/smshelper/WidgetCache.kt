package com.dabbar.smshelper

import android.content.Context
import java.text.NumberFormat
import java.util.Locale

/** كاش بسيط لأرقام الويدجت (أرقام فقط، من غير أي بيانات حساسة) عشان الويدجت يترسم فورًا من غير نت. */
object WidgetCache {
    private const val FILE = "dabbar_widget_cache"
    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun save(c: Context, month: String, balance: Long, income: Long, expense: Long, todayExpense: Long, todayCount: Int) {
        prefs(c).edit().putString("month", month).putLong("balance", balance).putLong("income", income)
            .putLong("expense", expense).putLong("todayExpense", todayExpense).putInt("todayCount", todayCount)
            .putBoolean("hasData", true).putLong("updatedAt", System.currentTimeMillis()).apply()
    }
    fun hasData(c: Context) = prefs(c).getBoolean("hasData", false)
    fun month(c: Context) = prefs(c).getString("month", "") ?: ""
    fun balance(c: Context) = prefs(c).getLong("balance", 0)
    fun income(c: Context) = prefs(c).getLong("income", 0)
    fun expense(c: Context) = prefs(c).getLong("expense", 0)
    fun todayExpense(c: Context) = prefs(c).getLong("todayExpense", 0)
    fun todayCount(c: Context) = prefs(c).getInt("todayCount", 0)

    fun money(value: Long): String = NumberFormat.getIntegerInstance(Locale("ar", "EG")).format(value) + " ج.م"
}
