plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.dabbar.smshelper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dabbar.smshelper"
        minSdk = 26 // NotificationListenerService مستقر من هنا، وبيغطي الأغلبية الساحقة من مستخدمي دبّر
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // مكتبات قليلة جدًا عمدًا — عشان نفضل قريبين من هدف الـ 2 ميجا.
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")       // إعادة محاولة الإرسال عند انقطاع النت
    implementation("androidx.security:security-crypto:1.1.0-alpha06") // تخزين التوكن مشفّر
    // ملحوظة: استخدمنا org.json المدمجة في أندرويد + HttpURLConnection بدل Retrofit/OkHttp/Gson
    // عشان نقلل حجم الـ APK — لو حجم OkHttp (~120KB) مقبول ليك ممكن نضيفه بدل HttpURLConnection
    // اليدوي لو حبيت تبسيط الكود أكتر.
}
