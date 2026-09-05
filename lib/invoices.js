import { supabase } from './supabaseClient.js';
import { sendTelegramMessage } from './telegram.js';
import { recordDebt } from './debts.js';
import { CATEGORY_EMOJI } from './config.js';
import { maybeSendBudgetAlert } from './webPush.js';

// ============ القلب: يحفظ الفاتورة + كل صنف كـ expense مربوط بيها + دين لو الفاتورة نفسها دين — من غير أي رسالة تليجرام ============
// ده الجزء المشترك بين مسار البوت (تليجرام) ومسار الداشبورد (Smart Receipt Scanner)، عشان منكررش
// منطق الحفظ في مكانين. بيرجّع { invoiceId, itemsCount } أو null لو فشل الإدراج الأساسي.
export async function saveInvoiceRecord(receipt, userId) {
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      telegram_user_id: userId,
      merchant: receipt.merchant || '',
      total_amount: receipt.totalAmount,
      payment_method: receipt.paymentMethod || '',
      invoice_number: receipt.invoiceNumber || '',
      is_debt: Boolean(receipt.isDebt),
      debt_person: receipt.debtPerson || '',
    })
    .select('id')
    .single();

  if (invoiceError || !invoice) {
    console.error('saveInvoiceRecord insert error:', JSON.stringify(invoiceError));
    return null;
  }

  const itemRows = receipt.items.map((it) => ({
    invoice_id: invoice.id,
    telegram_user_id: userId,
    name: it.name,
    category: it.category,
    amount: it.amount,
  }));

  const expenseRows = receipt.items.map((it) => ({
    telegram_user_id: userId,
    amount: it.amount,
    category: it.category,
    description: it.name,
    invoice_id: invoice.id,
  }));

  const [{ error: itemsError }, { error: expensesError }] = await Promise.all([
    supabase.from('invoice_items').insert(itemRows),
    supabase.from('expenses').insert(expenseRows),
  ]);

  if (itemsError) console.error('saveInvoiceRecord invoice_items insert error:', JSON.stringify(itemsError));
  if (expensesError) console.error('saveInvoiceRecord expenses insert error:', JSON.stringify(expensesError));
  if (!expensesError) await maybeSendBudgetAlert(userId).catch((pushError) => console.error('saveInvoiceRecord budget push failed:', pushError));

  if (receipt.isDebt && receipt.debtPerson) {
    await recordDebt(
      {
        person: receipt.debtPerson,
        amount: receipt.totalAmount,
        direction: 'borrowed',
        is_repayment: false,
        note: `فاتورة ${receipt.merchant || ''}`.trim(),
      },
      userId,
      null
    ).catch((err) => console.error('saveInvoiceRecord: recordDebt failed', err));
  }

  return { invoiceId: invoice.id, itemsCount: receipt.items.length };
}

// ============ تسجيل فاتورة كاملة من مسار تليجرام: بتحفظ (عبر saveInvoiceRecord) وبعدين تبعت رسالة تأكيد ============
export async function recordInvoice(receipt, userId, chatId, extraFooter = '') {
  const saved = await saveInvoiceRecord(receipt, userId);

  if (!saved) {
    await sendTelegramMessage(chatId, '⚠️ حصل خطأ وأنا بسجل الفاتورة، مش اتسجلت. جرب تاني كمان شوية.');
    return null;
  }

  await sendInvoiceConfirmation(receipt, saved.invoiceId, chatId, extraFooter);
  return saved.invoiceId;
}

// ============ رسالة تأكيد واحدة بكل الأصناف — بديل عن رسالة "تمام سجلت المصروف" العادية ============
async function sendInvoiceConfirmation(receipt, invoiceId, chatId, extraFooter) {
  const title = receipt.merchant ? `فاتورة ${receipt.merchant}` : 'الفاتورة';
  let msg = `✅ <b>${title} — اتسجلت (${receipt.items.length} صنف)</b>\n\n`;

  for (const it of receipt.items) {
    const emoji = CATEGORY_EMOJI[it.category] || '📌';
    msg += `${emoji} ${it.name} — ${it.amount} جنيه\n`;
  }

  msg += `\n💰 <b>الإجمالي:</b> ${receipt.totalAmount} جنيه`;

  if (receipt.isDebt && receipt.debtPerson) {
    msg += `\n\n📥 اتسجلت كمان كدين عليك لـ <b>${receipt.debtPerson}</b>`;
  }

  if (extraFooter) msg += `\n\n${extraFooter}`;

  await sendTelegramMessage(chatId, msg, 'HTML', {
    inline_keyboard: [[{ text: '🗑 حذف الفاتورة دي', callback_data: `delinv:${invoiceId}` }]],
  });
}

// ============ حذف فاتورة كاملة: بيمسح الفاتورة، وكل الأصناف والمصاريف المرتبطة بيها (cascade + الدين لو موجود) ============
export async function deleteInvoiceById(invoiceId, userId) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('merchant, total_amount')
    .eq('id', invoiceId)
    .eq('telegram_user_id', userId)
    .single();

  if (!invoice) return null;

  // الأصناف بتتمسح تلقائي عبر "on delete cascade"، والمصاريف المرتبطة بنمسحها يدويًا هنا
  await supabase.from('expenses').delete().eq('invoice_id', invoiceId).eq('telegram_user_id', userId);
  await supabase.from('invoices').delete().eq('id', invoiceId).eq('telegram_user_id', userId);

  return invoice;
}

// ============ ليستة كل الفواتير لمستخدم — للداشبورد (شاشة "كل الفواتير") ============
export async function getInvoicesList(userId, limit = 50) {
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('id, merchant, total_amount, payment_method, is_debt, debt_person, created_at')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('getInvoicesList error:', JSON.stringify(error));
    return [];
  }
  if (!invoices || invoices.length === 0) return [];

  const ids = invoices.map((inv) => inv.id);
  const { data: counts } = await supabase
    .from('invoice_items')
    .select('invoice_id')
    .in('invoice_id', ids);

  const countByInvoice = {};
  for (const row of counts || []) {
    countByInvoice[row.invoice_id] = (countByInvoice[row.invoice_id] || 0) + 1;
  }

  return invoices.map((inv) => ({ ...inv, item_count: countByInvoice[inv.id] || 0 }));
}

// ============ تفاصيل فاتورة واحدة بكل أصنافها — للداشبورد (لما يدوس على فاتورة معيّنة من الليستة) ============
export async function getInvoiceDetail(userId, invoiceId) {
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('id, merchant, total_amount, payment_method, invoice_number, is_debt, debt_person, created_at')
    .eq('id', invoiceId)
    .eq('telegram_user_id', userId)
    .single();

  if (invoiceError || !invoice) return null;

  const { data: items, error: itemsError } = await supabase
    .from('invoice_items')
    .select('id, name, category, amount')
    .eq('invoice_id', invoiceId)
    .order('id', { ascending: true });

  if (itemsError) console.error('getInvoiceDetail items error:', JSON.stringify(itemsError));

  return { ...invoice, items: items || [] };
}
