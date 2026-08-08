import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import path from 'path';

// ============ تحويل صفحة HTML كاملة لملف PDF (بيستخدم Chromium متوافق مع بيئة Vercel serverless) ============
//
// ملحوظة عن إيرور "libnss3.so: cannot open shared object file" اللي كنا بنشوفه:
// السبب الحقيقي إن مكتبة @sparticuz/chromium محتاجة تعرف إنها شغالة على بيئة "AWS Lambda-style"
// (اللي Vercel مبني عليها) عشان تجيب المكتبات المطلوبة (نظام NSS) صح، وده بيتحدد بمتغيّر بيئة
// اسمه AWS_LAMBDA_JS_RUNTIME. لازم يتظبط من إعدادات Vercel نفسها (مش هنا في الكود)، لأن المكتبة
// بتقرأه أول ما بتتحمّل، قبل ما أي كود بتاعنا يشتغل خالص.
// بعد ما يتظبط، برضو محتاجين نقول لنظام التشغيل يدوّر على المكتبات دي في المكان الصح — ده اللي
// بيعمله LD_LIBRARY_PATH تحت.
export async function renderPdfFromHtml(html) {
  chromium.setGraphicsMode = false; // مفيش داعي لمكتبات الرسوميات الكاملة — بيقلل احتمال مشاكل تشغيل تانية

  const executablePath = await chromium.executablePath();

  // نضيف مجلد الـ Chromium نفسه لمسار البحث عن المكتبات المشتركة (بما فيها libnss3.so)
  const execDir = path.dirname(executablePath);
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${execDir}:${process.env.LD_LIBRARY_PATH}`
    : execDir;

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    // الرسم البياني بقى SVG جوّاني والخطوط بقت من النظام — مفيش أي طلب شبكة هنا خالص،
    // فـ 'load' كفاية (وأسرع وأضمن من 'networkidle0' اللي كانت بتستنى شبكة ممكن تتأخر/تفشل)
    await page.setContent(html, { waitUntil: 'load', timeout: 8000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}
