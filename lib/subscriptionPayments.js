import crypto from 'node:crypto';
import { supabase } from './supabaseClient.js';
import { SUBSCRIPTION_BANK_ACCOUNT_LAST4, SUBSCRIPTION_BANK_SENDERS, SUBSCRIPTION_SMS_WEBHOOK_TOKEN, SUBSCRIPTION_PRICE_EGP, SUBSCRIPTION_DAYS } from './config.js';
import { activateSubscription } from './users.js';

export function normalizeReference(value) {
  return String(value || '').toUpperCase().replace(/[\s\-_.:/#]+/g, '').replace(/[^A-Z0-9]/g, '');
}

function normalizeDigits(value) {
  return String(value || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

export function extractPaymentFromSms(text) {
  const raw = normalizeDigits(text);
  const currencyFirst = [...raw.matchAll(/(\d{1,8}(?:[.,]\d{1,2})?)\s*(?:EGP|جنيه(?:ًا)?)/gi)]
    .map((m) => Number(m[1].replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0);
  const amountMatches = [...raw.matchAll(/(?:EGP|جنيه|جنيهًا|مبلغ|amount|ثمن|قيمة)[^\d]{0,18}(\d{1,8}(?:[.,]\d{1,2})?)/gi)]
    .map((m) => Number(m[1].replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0);
  const fallbackAmounts = [...raw.matchAll(/\b(\d{2,8}(?:[.,]\d{1,2})?)\b/g)]
    .map((m) => Number(m[1].replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0);
  const amount = currencyFirst[0] || amountMatches[0] || fallbackAmounts.find((n) => Math.abs(n - Number(SUBSCRIPTION_PRICE_EGP)) < 0.01) || null;
  const refMatch = raw.match(/(?:reference|ref(?:erence)?\s*(?:no|number|id)?|transaction\s*(?:id|no|number)|رقم\s*(?:ال)?مرجع|مرجع|رقم\s*العملية|رقم\s*الحركة)\s*[:#№-]?\s*([A-Z0-9][A-Z0-9\- _./]{3,80})/i);
  const reference = normalizeReference(refMatch?.[1] || '');
  return { reference, amount, rawText: raw.slice(0, 4000) };
}

export function isSubscriptionSmsAuthorized({ token, sender = '', text = '' }) {
  if (!SUBSCRIPTION_SMS_WEBHOOK_TOKEN || String(token || '') !== SUBSCRIPTION_SMS_WEBHOOK_TOKEN) return false;
  const senderNorm = String(sender).trim().toLowerCase();
  if (SUBSCRIPTION_BANK_SENDERS.length && !SUBSCRIPTION_BANK_SENDERS.some((allowed) => senderNorm.includes(allowed))) return false;
  if (SUBSCRIPTION_BANK_ACCOUNT_LAST4 && !new RegExp(`(?:${SUBSCRIPTION_BANK_ACCOUNT_LAST4})\\b`).test(normalizeDigits(text))) return false;
  return true;
}

function smsFingerprint({ sender, text }) {
  return crypto.createHash('sha256').update(`${String(sender || '').trim().toLowerCase()}\n${String(text || '').trim()}`).digest('hex');
}

async function markMatched(proof, sms) {
  const { data: claimed, error } = await supabase.from('subscription_proofs').update({
    status: 'activated',
    matched_sms_id: sms.id,
    bank_reference: sms.reference,
    bank_amount: sms.amount,
    matched_at: new Date().toISOString(),
    verification_reason: 'exact_reference_and_amount_match',
  }).eq('id', proof.id).eq('status', 'pending').select('id').maybeSingle();
  if (error || !claimed) return { matched: false, reason: 'proof_already_processed' };
  const expiry = await activateSubscription(proof.telegram_user_id, SUBSCRIPTION_DAYS);
  if (!expiry) {
    await supabase.from('subscription_proofs').update({ status: 'pending', matched_sms_id: null, matched_at: null, verification_reason: 'activation_failed_retry' }).eq('id', proof.id).eq('status', 'activated');
    return { matched: false, reason: 'activation_failed' };
  }
  await supabase.from('subscription_payment_sms').update({ status: 'matched', matched_proof_id: proof.id, matched_at: new Date().toISOString() }).eq('id', sms.id).eq('status', 'pending');
  return { matched: true, expiry };
}

export async function tryMatchPendingProof(proofId) {
  const { data: proof } = await supabase.from('subscription_proofs').select('*').eq('id', proofId).maybeSingle();
  if (!proof || proof.status !== 'pending' || !proof.extracted_reference || !proof.extracted_amount) return { matched: false, reason: 'proof_needs_review' };
  const { data: smsRows } = await supabase.from('subscription_payment_sms').select('*').eq('status', 'pending').order('received_at', { ascending: true }).limit(100);
  const sms = (smsRows || []).find((row) => normalizeReference(row.reference) === normalizeReference(proof.extracted_reference) && Math.abs(Number(row.amount) - Number(proof.extracted_amount)) < 0.01);
  return sms ? markMatched(proof, sms) : { matched: false, reason: 'waiting_for_owner_sms' };
}

export async function ingestOwnerSubscriptionSms({ sender, text }) {
  const parsed = extractPaymentFromSms(text);
  if (!parsed.reference || !parsed.amount) return { accepted: false, reason: 'reference_or_amount_unclear' };
  const fingerprint = smsFingerprint({ sender, text });
  const { data: sms, error } = await supabase.from('subscription_payment_sms').upsert({
    fingerprint, sender: String(sender || '').slice(0, 160), raw_text: parsed.rawText,
    reference: parsed.reference, amount: parsed.amount, status: 'pending', received_at: new Date().toISOString(),
  }, { onConflict: 'fingerprint', ignoreDuplicates: true }).select('*').maybeSingle();
  if (error) throw error;
  if (!sms) return { accepted: true, duplicate: true };
  const { data: proofs } = await supabase.from('subscription_proofs').select('*').eq('status', 'pending').eq('extracted_reference', parsed.reference).eq('extracted_amount', parsed.amount).order('created_at', { ascending: true }).limit(10);
  for (const proof of proofs || []) {
    const result = await markMatched(proof, sms);
    if (result.matched) return { accepted: true, matched: true, proofId: proof.id, expiry: result.expiry };
  }
  return { accepted: true, matched: false, reason: 'waiting_for_customer_proof' };
}
