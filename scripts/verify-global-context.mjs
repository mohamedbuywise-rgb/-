import assert from 'node:assert/strict';
import { DEFAULT_GLOBAL_CONTEXT, normalizeGlobalContext, formatMoney, assistantContextBlock } from '../src/lib/globalContext.js';

const egypt = normalizeGlobalContext({});
assert.equal(egypt.countryCode, 'EG');
assert.equal(egypt.language, 'ar');
assert.equal(egypt.currencyCode, 'EGP');
assert.equal(egypt.timezone, 'Africa/Cairo');

const france = normalizeGlobalContext({
  country: 'France', countryCode: 'FR', language: 'en', currency: 'Euro', currencyCode: 'EUR', locale: 'en-FR', timezone: 'Europe/Paris'
});
assert.equal(france.countryCode, 'FR');
assert.equal(france.language, 'en');
assert.equal(formatMoney(1234.5, france), '€1,234.50');
assert.match(assistantContextBlock(france), /Currency: EUR/);
assert.equal(normalizeGlobalContext({ language: 'xx', countryCode: 'bad', currencyCode: 'bad' }).language, DEFAULT_GLOBAL_CONTEXT.language);

console.log('global_context_tests_ok');
