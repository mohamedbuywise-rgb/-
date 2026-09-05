import { supabase } from './supabaseClient.js';
import { getUnitPriceEgpForAsset } from './marketPrices.js';

// ============ تفاصيل أصل واحد كاملة عند فتحه: سعر السوق اللحظي + تاريخ القيمة من الصور المحفوظة ============
// بيتنادى وقت ما المستخدم يدوس على الأصل في الداشبورد، عشان يجيب سعر السوق دلوقتي (لو الأصل قابل للتسعير
// التلقائي زي الذهب/الكريبتو) وتاريخ حركة قيمته من جدول portfolio_snapshots من غير ما يحفظ/يغيّر أي حاجة.
export async function getPortfolioAssetDetail(userId, assetId) {
  const { data: asset, error } = await supabase
    .from('portfolio_assets')
    .select('*')
    .eq('id', assetId)
    .eq('telegram_user_id', userId)
    .single();
  if (error || !asset) return { error: 'الأصل ده مش موجود.' };

  const unitPriceEgp = await getUnitPriceEgpForAsset(asset).catch(() => null);

  const { data: snapshots } = await supabase
    .from('portfolio_snapshots')
    .select('created_at, assets_json')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(60);

  const targetName = normalizeAssetName(asset.name);
  const history = (snapshots || [])
    .map((s) => {
      const match = (s.assets_json || []).find((a) => normalizeAssetName(a.name) === targetName);
      return match ? { date: s.created_at, amount: Number(match.amount || 0) } : null;
    })
    .filter(Boolean);
  history.push({ date: asset.updated_at || asset.created_at, amount: Number(asset.amount || 0) });

  return { asset, unitPriceEgp, history };
}

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

// ============ تحديث أسعار السوق تلقائيًا للأصول القابلة للتسعير (ذهب/عملات رقمية) ============
// بيحسب القيمة الحالية = الكمية المسجّلة (quantity) × سعر الوحدة اللحظي، وبيسيب cost_basis زي ما هو
// عشان الفرق بينه وبين القيمة الجديدة يبقى المكسب/الخسارة غير المحقق (بيتحسب في الواجهة).
// الأصول اللي معندهاش quantity، أو نوعها مش مدعوم تلقائيًا (زي عقارات/صناديق/كاش)، بتتسيب زي ما هي.
export async function refreshPortfolioMarketPrices(userId) {
  const { assets } = await getPortfolio(userId);
  const updated = [];
  const skipped = [];

  for (const asset of assets) {
    const qty = Number(asset.quantity);
    if (!Number.isFinite(qty) || qty <= 0) { skipped.push(asset.id); continue; }

    const unitPriceEgp = await getUnitPriceEgpForAsset(asset);
    if (!unitPriceEgp) { skipped.push(asset.id); continue; }

    const newAmount = Math.round(unitPriceEgp * qty * 100) / 100;
    const { data, error } = await supabase
      .from('portfolio_assets')
      .update({ amount: newAmount, updated_at: new Date().toISOString() })
      .eq('id', asset.id)
      .eq('telegram_user_id', userId)
      .select('*')
      .single();

    if (error) { console.error('refreshPortfolioMarketPrices update error:', JSON.stringify(error)); skipped.push(asset.id); continue; }
    updated.push(data);
  }

  return { ok: true, updatedCount: updated.length, skippedCount: skipped.length };
}

// ============================================================
// ============ تتبع تاريخ المحفظة (snapshots) + ملخص حركة كل 3 أيام ============
// ============================================================
// جدول portfolio_snapshots لازم ينفّذ الـ migration بتاعه الأول (sql/portfolio-snapshots.sql)

// ============ تسجيل "صورة" للمحفظة دلوقتي (الإجمالي + تفاصيل كل أصل) — بتتنفذ يوميًا من الكرون ============
export async function savePortfolioSnapshot(userId) {
  const { assets, total } = await getPortfolio(userId);
  if (!assets.length) return { skipped: true }; // مفيش داعي نسجل صورة لمحفظة فاضية

  const assetsJson = assets.map((a) => ({ id: a.id, name: a.name, sub_label: a.sub_label || null, amount: Number(a.amount || 0) }));

  const { error } = await supabase
    .from('portfolio_snapshots')
    .insert({ telegram_user_id: userId, total, assets_json: assetsJson });

  if (error) {
    console.error('savePortfolioSnapshot error:', JSON.stringify(error));
    return { error: 'snapshot-save-failed' };
  }
  return { ok: true };
}

// ============ أقرب صورة مسجّلة لأصل حد أدنى من الأيام دي (افتراضيًا 3) — بنرجع أقدم واحدة لسه ضمن النطاق ============
async function getReferenceSnapshot(userId, minDaysAgo = 3) {
  const cutoff = new Date(Date.now() - minDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('total, assets_json, created_at')
    .eq('telegram_user_id', userId)
    .lte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getReferenceSnapshot error:', JSON.stringify(error));
    return null;
  }
  return data || null;
}

// ============ ملخص حركة المحفظة (إجمالي + كل أصل لوحده) بالمقارنة بآخر صورة قبل 3 أيام على الأقل ============
// بيرجع null لو مفيش صورة قديمة كفاية للمقارنة (يعني المستخدم لسه جديد على الميزة دي).
export async function getPortfolioDigest(userId, minDaysAgo = 3) {
  const [{ assets, total }, reference] = await Promise.all([
    getPortfolio(userId),
    getReferenceSnapshot(userId, minDaysAgo),
  ]);

  if (!reference || !assets.length) return null;

  const prevTotal = Number(reference.total || 0);
  const changeAmount = Math.round((total - prevTotal) * 100) / 100;
  const changePct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : 0;

  const prevByName = new Map((reference.assets_json || []).map((a) => [normalizeAssetName(a.name), Number(a.amount || 0)]));
  const perAsset = assets.map((a) => {
    const prevAmount = prevByName.get(normalizeAssetName(a.name));
    if (prevAmount === undefined || prevAmount <= 0) return { id: a.id, name: a.name, changeAmount: null, changePct: null };
    const assetChangeAmount = Math.round((Number(a.amount || 0) - prevAmount) * 100) / 100;
    const assetChangePct = Math.round(((Number(a.amount || 0) - prevAmount) / prevAmount) * 1000) / 10;
    return { id: a.id, name: a.name, changeAmount: assetChangeAmount, changePct: assetChangePct };
  });

  return {
    total, prevTotal, changeAmount, changePct,
    referenceDate: reference.created_at,
    perAsset,
  };
}

// ============ صياغة رسالة تليجرام لملخص حركة المحفظة (بتتبعت مرة كل 3 أيام) ============
export function buildPortfolioDigestMessage(digest) {
  if (!digest) return null;
  const arrow = digest.changeAmount >= 0 ? '📈' : '📉';
  const sign = digest.changeAmount >= 0 ? '+' : '';
  const fmt = (n) => Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 0 });

  let msg = `${arrow} <b>دبّر يقرأك — محفظتك خلال 3 أيام</b>\n━━━━━━━━━━━━━━━\n\n`;
  msg += `الإجمالي دلوقتي: <b>${fmt(digest.total)} ج.م</b>\n`;
  msg += `${sign}${fmt(digest.changeAmount)} ج.م (${sign}${digest.changePct}%) عن آخر 3 أيام\n\n`;

  const notable = digest.perAsset
    .filter((a) => a.changePct !== null && Math.abs(a.changePct) >= 0.5)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 4);

  if (notable.length) {
    msg += `أبرز الحركات:\n`;
    for (const a of notable) {
      const assetArrow = a.changePct >= 0 ? '▲' : '▼';
      const assetSign = a.changePct >= 0 ? '+' : '';
      msg += `• ${a.name}: ${assetArrow} ${assetSign}${a.changePct}%\n`;
    }
  }

  return msg;
}
