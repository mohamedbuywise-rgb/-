package com.dabbar.smshelper

/**
 * مرآة (mirror) لقايمة lib/bank-senders.js في الباك إند — لازم تفضل متزامنة معاها.
 * الهدف: فلترة الإشعارات على الجهاز نفسه قبل ما نبعت أي حاجة للسيرفر، فمفيش داعي نستهلك
 * الـ Webhook أو Groq API على إشعارات مش بنكية خالص.
 *
 * TODO: بدل ما نكرر القايمة يدويًا هنا وفي lib/bank-senders.js، ممكن نعمل endpoint بسيط
 * زي /api/bank-senders يرجّعها JSON والتطبيق يكاشها محليًا ويحدثها كل فترة — كده تحديث
 * قايمة البنوك ميحتاجش إصدار نسخة جديدة من الـ APK.
 */
object BankSenderMatcher {

    private val knownSenders: List<String> = listOf(
        "CIB", "CIB EGYPT",
        "NBE", "AHLY", "National Bank",
        "Banque Misr", "BM",
        "QNB", "QNB ALAHLI",
        "HSBC",
        "AAIB",
        "Al Baraka", "Baraka Bank",
        "FAB",
        "ADIB",
        "CAE", "Credit Agricole",
        "Faisal Bank",
        "Mashreq",
        "United Bank", "UB",
        "Vodafone Cash", "VFCash",
        "Etisalat Cash",
        "Orange Cash", "Orange Money",
        "WE Pay", "WEPay",
        "InstaPay", "Insta Pay",
        "Fawry",
    )

    /** بيرجع اسم المرسل المطابق (نفس النص الأصلي اللي هيتبعت للسيرفر)، أو null لو مفيش تطابق. */
    fun match(rawSender: String): String? {
        val normalized = rawSender.trim().lowercase()
        if (normalized.isEmpty()) return null
        for (sender in knownSenders) {
            val s = sender.lowercase()
            if (normalized == s || normalized.contains(s) || s.contains(normalized)) {
                return rawSender.trim()
            }
        }
        return null
    }
}
