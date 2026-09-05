import sharp from 'sharp';

// ============ معالجة أولية "مجانية" للصورة قبل ما تروح لـ Groq Vision ============
// بتحصل بالكامل جوه السيرفر بمكتبة sharp (معالجة صور محليّة، من غير أي استدعاء أو تكلفة خارجية)،
// وهدفها حاجتين مع بعض:
//   1) رفع دقة قراءة OCR: تصحيح الدوران حسب EXIF، تحويل لـ Grayscale، وتحسين التباين (Normalize) —
//      بيوضّح الأرقام والنص في الفواتير المصوّرة بإضاءة سيئة أو بكاميرا موبايل عادية.
//   2) تصغير حجم البيانات اللي بتتبعت لـ Groq Vision (تكلفة الـ API متأثرة بحجم/دقة الصورة)، من غير
//      ما نضحّي بالوضوح، عشان نفضل جوه الميزانية الشهرية المستهدفة.
//
// mode: 'standard' = المحاولة الأولى (أخف حجم وأرخص وأسرع، كافية في الغالبية العظمى من الحالات)
//       'enhanced'  = "نظام الرؤية المتقدم" — محاولة تانية بجودة/دقة أعلى شوية لو الأولى فشلت في القراءة،
//                      لسه بره بره من غير أي تكلفة خارجية إضافية (نفس المكتبة المحلية بس بإعدادات أعلى).
export async function preprocessReceiptImage(buffer, { mode = 'standard' } = {}) {
  try {
    const maxWidth = mode === 'enhanced' ? 2000 : 1400;
    const jpegQuality = mode === 'enhanced' ? 90 : 80;

    const metadata = await sharp(buffer).metadata().catch(() => null);

    let pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // .rotate() من غير args = يصحح الدوران حسب EXIF

    if (!metadata?.width || metadata.width > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    }

    pipeline = pipeline
      .grayscale()   // تحويل لتدرج رمادي — بيبسّط الصورة على الموديل ويقلل تشتيت الألوان عن النص
      .normalize()   // تحسين تباين تلقائي (contrast stretching) — بيوضّح النص الباهت
      .sharpen();    // زيادة حدة بسيطة تساعد في قراءة الأرقام الصغيرة

    return await pipeline.jpeg({ quality: jpegQuality }).toBuffer();
  } catch (err) {
    console.error('preprocessReceiptImage failed, falling back to original image:', err);
    // الاستقرار أهم من التحسين — لو المعالجة فشلت لأي سبب (صيغة غريبة، صورة تالفة جزئيًا...)،
    // نرجع الصورة الأصلية زي ما هي بدل ما نوقف ميزة "امسح فاتورة" بالكامل.
    return buffer;
  }
}
