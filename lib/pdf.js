import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// ============ تحويل صفحة HTML كاملة لملف PDF (بيستخدم Chromium متوافق مع بيئة Vercel serverless) ============
export async function renderPdfFromHtml(html) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    // networkidle0 عشان ننتظر تحميل الرسم البياني (بييجي من رابط خارجي) قبل ما نطبع الملف
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
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
