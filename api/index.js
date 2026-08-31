import adminHandler from '../backend/api-handlers/admin.js';
import assistantHandler from '../backend/api-handlers/assistant.js';
import authByCodeHandler from '../backend/api-handlers/auth-by-code.js';
import bankAccountsHandler from '../backend/api-handlers/bank-accounts.js';
import bankMovementsHandler from '../backend/api-handlers/bank-movements.js';
import cronDailyHandler from '../backend/api-handlers/cron-daily.js';
import dashboardDataHandler from '../backend/api-handlers/dashboard-data.js';
import financialActionsHandler from '../backend/api-handlers/financial-actions.js';
import pushHandler from '../backend/api-handlers/push.js';
import reportsHandler from '../backend/api-handlers/reports.js';
import setupHandler from '../backend/api-handlers/setup.js';
import smsWebhookHandler from '../backend/api-handlers/sms-webhook.js';
import supportMessageHandler from '../backend/api-handlers/support-message.js';
import telegramWebhookHandler from '../backend/api-handlers/telegram-webhook.js';
import trialSummaryProofHandler from '../backend/api-handlers/trial-summary-proof.js';
import trialSummaryHandler from '../backend/api-handlers/trial-summary.js';

const handlers = {
  admin: adminHandler,
  assistant: assistantHandler,
  'auth-by-code': authByCodeHandler,
  'bank-accounts': bankAccountsHandler,
  'bank-movements': bankMovementsHandler,
  'cron-daily': cronDailyHandler,
  'dashboard-data': dashboardDataHandler,
  'financial-actions': financialActionsHandler,
  push: pushHandler,
  reports: reportsHandler,
  setup: setupHandler,
  'sms-webhook': smsWebhookHandler,
  'support-message': supportMessageHandler,
  'telegram-webhook': telegramWebhookHandler,
  'trial-summary-proof': trialSummaryProofHandler,
  'trial-summary': trialSummaryHandler,
};

export default async function handler(req, res) {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  const routeHandler = handlers[route];
  if (!routeHandler) {
    return res.status(404).json({ ok: false, error: 'API route not found' });
  }
  return routeHandler(req, res);
}
