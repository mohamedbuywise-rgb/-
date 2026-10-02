import { getEgpPerUnit } from './fx.js';
export async function convertFromEgp(amount, currencyCode) {
  const code = String(currencyCode || 'EGP').toUpperCase();
  const n = Number(amount || 0);
  if (code === 'EGP') return n;
  const egpPerUnit = await getEgpPerUnit(code);
  return egpPerUnit ? Math.round((n / egpPerUnit) * 100) / 100 : n;
}
