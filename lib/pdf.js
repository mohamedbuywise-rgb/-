import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';
import path from 'path';

// ============ تحويل صفحة HTML كاملة لملف PDF (بيستخدم Playwright + Chromium متوافق مع بيئة Vercel) ============
// استبدلنا puppeteer-core بـ playwright-core لأنه أثبت استقرار أكبر في بيئات Serverless الحديثة
// خصوصًا مع مشاكل نقص مكتبات النظام (libnss3.so).
export async function renderPdfFromHtml(html) {
  chromium.setGraphicsMode = false;

  const executablePath = await chromium.executablePath();

  // تأمين مسارات المكتبات المطلوبة
  const execDir = path.dirname(executablePath);
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${execDir}:${process.env.LD_LIBRARY_PATH}`
    : execDir;

  const browser = await playwright.launch({
    args: chromium.args,
    executablePath,
    // ملحوظة: chromium.headless في نسخ @sparticuz/chromium الحديثة بترجّع نص (مثلاً "shell")
    // مش boolean، و playwright-core بيرفض أي حاجة غير true/false. بنثبتها true يدوي هنا.
    headless: true,
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // ضبط المحتوى والانتظار حتى التحميل
    await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    
    // توليد الـ PDF
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
