import { supabase } from './supabaseClient.js';

// ============ جلب أصول المحفظة الحقيقية للمستخدم + الإجمالي ============
export async function getPortfolio(userId) {
  const { data, error } = await supabase
    .from('portfolio_assets')
    .select('*')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('getPortfolio error:', JSON.stringify(error));
    return { assets: [], total: 0 };
  }

  const assets = data || [];
  const total = assets.reduce((sum, a) => sum + Number(a.amount || 0), 0);
  return { assets, total };
}

// ============ إضافة أصل جديد للمحفظة ============
export async function addPortfolioAsset(userId, { name, subLabel, amount }) {
  const cleanName = (name || '').trim();
  const cleanAmount = Number(amount);
  if (!cleanName || !cleanAmount || cleanAmount <= 0) {
    return { error: 'محتاج اسم الأصل وقيمة صحيحة أكبر من صفر.' };
  }

  const { data, error } = await supabase
    .from('portfolio_assets')
    .insert({ telegram_user_id: userId, name: cleanName, sub_label: (subLabel || '').trim() || null, amount: cleanAmount })
    .select('*')
    .single();

  if (error) {
    console.error('addPortfolioAsset error:', JSON.stringify(error));
    return { error: 'حصل خطأ وإحنا بنضيف الأصل، جرب تاني.' };
  }
  return { asset: data };
}

// ============ تحديث قيمة أصل موجود ============
export async function updatePortfolioAsset(userId, assetId, { name, subLabel, amount }) {
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) patch.name = String(name).trim();
  if (subLabel !== undefined) patch.sub_label = String(subLabel || '').trim() || null;
  if (amount !== undefined) {
    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount <= 0) return { error: 'محتاج قيمة صحيحة أكبر من صفر.' };
    patch.amount = cleanAmount;
  }

  const { data, error } = await supabase
    .from('portfolio_assets')
    .update(patch)
    .eq('id', assetId)
    .eq('telegram_user_id', userId)
    .select('*')
    .single();

  if (error) {
    console.error('updatePortfolioAsset error:', JSON.stringify(error));
    return { error: 'حصل خطأ وإحنا بنحدّث الأصل، جرب تاني.' };
  }
  return { asset: data };
}

// ============ تطبيع اسم الأصل للمطابقة (يشيل التشكيل/المسافات الزيادة ويوحّد الألف/الياء) ============
function normalizeAssetName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

// ============ الدوّار على أقرب أصل مطابق بالاسم عند المستخدم (تطابق تام، ثم احتواء جزئي) ============
export async function findMatchingAsset(userId, name) {
  const target = normalizeAssetName(name);
  if (!target) return null;
  const { assets } = await getPortfolio(userId);
  const exact = assets.find((a) => normalizeAssetName(a.name) === target);
  if (exact) return exact;
  const partial = assets.filter(
    (a) => normalizeAssetName(a.name).includes(target) || target.includes(normalizeAssetName(a.name)),
  );
  return partial.length === 1 ? partial[0] : null;
}

// ============ شراء أصل استثماري: بيتحول لتحويل مالي (مش مصروف) + يزوّد/ينشئ الأصل في المحفظة ============
// بيدوّر أول حاجة على أصل موجود بنفس الاسم (تطابق ذكي)؛ لو لقاه يزوّد الكمية والتكلفة والقيمة الحالية عليه،
// لو مش لاقي ينشئ أصل جديد. القيمة الحالية (amount) بتتحدث بنفس مبلغ الشراء لحد ما المستخدم يحدّثها يدويًا بسعر السوق.
export async function buyIntoPortfolio(userId, { name, quantity, unit, cost }) {
  const cleanName = String(name || '').trim();
  const cleanCost = Number(cost);
  if (!cleanName || !Number.isFinite(cleanCost) || cleanCost <= 0) {
    return { error: 'محتاج اسم الأصل ومبلغ شراء صحيح.' };
  }
  const cleanQty = Number(quantity);
  const hasQty = Number.isFinite(cleanQty) && cleanQty > 0;

  const existing = await findMatchingAsset(userId, cleanName);
  if (existing) {
    const patch = {
      amount: Number(existing.amount || 0) + cleanCost,
      cost_basis: Number(existing.cost_basis ?? existing.amount ?? 0) + cleanCost,
      updated_at: new Date().toISOString(),
    };
    if (hasQty) patch.quantity = Number(existing.quantity || 0) + cleanQty;
    if (!existing.unit && unit) patch.unit = String(unit).trim();
    const { data, error } = await supabase
      .from('portfolio_assets')
      .update(patch)
      .eq('id', existing.id)
      .eq('telegram_user_id', userId)
      .select('*')
      .single();
    if (error) {
      console.error('buyIntoPortfolio update error:', JSON.stringify(error));
      return { error: 'حصل خطأ وإحنا بنحدّث الأصل في محفظتك.' };
    }
    return { asset: data, created: false };
  }

  const { data, error } = await supabase
    .from('portfolio_assets')
    .insert({
      telegram_user_id: userId,
      name: cleanName,
      sub_label: hasQty && unit ? `${cleanQty} ${unit}` : null,
      amount: cleanCost,
      quantity: hasQty ? cleanQty : null,
      unit: unit ? String(unit).trim() : null,
      cost_basis: cleanCost,
    })
    .select('*')
    .single();
  if (error) {
    console.error('buyIntoPortfolio insert error:', JSON.stringify(error));
    return { error: 'حصل خطأ وإحنا بنضيف الأصل لمحفظتك.' };
  }
  return { asset: data, created: true };
}

// ============ بيع أصل استثماري (كله أو جزء): بيتحول لدخل حقيقي + يقلل/يحذف الأصل من المحفظة ============
// بيرجّع realizedGain (المكسب أو الخسارة المحققة من الصفقة دي بالظبط = عائد البيع - نصيب الجزء المباع من التكلفة).
// لو مفيش أصل مطابق أو الكمية المطلوب بيعها أكبر من الموجود، بيرجع error عشان نطلب من المستخدم يوضح
// (مينفعش نبيع حاجة مش متأكدين إنها موجودة أو بكمية أكبر مما هو متاح).
export async function sellFromPortfolio(userId, { name, quantity, proceeds }) {
  const cleanProceeds = Number(proceeds);
  if (!Number.isFinite(cleanProceeds) || cleanProceeds <= 0) return { error: 'محتاج مبلغ بيع صحيح.' };

  const existing = await findMatchingAsset(userId, name);
  if (!existing) return { error: 'notfound' };

  const existingQty = Number(existing.quantity);
  const cleanQty = Number(quantity);
  const hasBothQty = Number.isFinite(existingQty) && existingQty > 0 && Number.isFinite(cleanQty) && cleanQty > 0;

  if (hasBothQty && cleanQty > existingQty + 0.0001) {
    return { error: `عندك بس ${existingQty}${existing.unit ? ' ' + existing.unit : ''} من ${existing.name}، مش ${cleanQty}.` };
  }

  const existingAmount = Number(existing.amount || 0);
  const existingCostBasis = Number(existing.cost_basis ?? existing.amount ?? 0);
  // نسبة الجزء المباع: بالكمية لو متاحة عندنا، وإلا بافتراض بيع كل الأصل (مفيش كمية متسجلة أصلاً)
  const fraction = hasBothQty ? cleanQty / existingQty : 1;
  const isFullSale = fraction >= 0.9999;
  const removedCostBasis = existingCostBasis * fraction;
  const realizedGain = cleanProceeds - removedCostBasis;

  if (isFullSale) {
    const { error } = await supabase.from('portfolio_assets').delete().eq('id', existing.id).eq('telegram_user_id', userId);
    if (error) {
      console.error('sellFromPortfolio delete error:', JSON.stringify(error));
      return { error: 'حصل خطأ وإحنا بنحدّث محفظتك بعد البيع.' };
    }
    return { asset: existing, deleted: true, realizedGain, soldQuantity: hasBothQty ? existingQty : null, unit: existing.unit };
  }

  const patch = {
    amount: Math.max(existingAmount - existingAmount * fraction, 0),
    cost_basis: Math.max(existingCostBasis - removedCostBasis, 0),
    quantity: hasBothQty ? Number((existingQty - cleanQty).toFixed(6)) : existing.quantity,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('portfolio_assets')
    .update(patch)
    .eq('id', existing.id)
    .eq('telegram_user_id', userId)
    .select('*')
    .single();
  if (error) {
    console.error('sellFromPortfolio update error:', JSON.stringify(error));
    return { error: 'حصل خطأ وإحنا بنحدّث محفظتك بعد البيع.' };
  }
  return { asset: data, deleted: false, realizedGain, soldQuantity: hasBothQty ? cleanQty : null, unit: existing.unit };
}

// ============ حذف أصل من المحفظة ============
export async function deletePortfolioAsset(userId, assetId) {
  const { error } = await supabase
    .from('portfolio_assets')
    .delete()
    .eq('id', assetId)
    .eq('telegram_user_id', userId);

  if (error) {
    console.error('deletePortfolioAsset error:', JSON.stringify(error));
    return { error: 'حصل خطأ وإحنا بنحذف الأصل، جرب تاني.' };
  }
  return { ok: true };
}
