import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { supabase } from '../lib/supabaseClient.js';
import { getDashboardUserFromRequest } from '../lib/dashboardAuth.js';

const RP_NAME = 'Dabbar';
const RP_ID = process.env.PASSKEY_RP_ID || process.env.VERCEL_URL || 'buypilot-team.vercel.app';
const ORIGIN = process.env.PASSKEY_ORIGIN || `https://${RP_ID}`;
const b64 = (v) => Buffer.from(v).toString('base64url');
const unb64 = (v) => Buffer.from(v, 'base64url');
const saveChallenge = async (authUserId, challenge, purpose) => supabase.from('passkey_challenges').insert({ auth_user_id: authUserId || null, challenge, purpose, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
const takeChallenge = async (challenge, purpose, authUserId = null) => {
  let q = supabase.from('passkey_challenges').select('*').eq('challenge', challenge).eq('purpose', purpose).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1);
  if (authUserId) q = q.eq('auth_user_id', authUserId);
  const { data } = await q.maybeSingle();
  if (data) await supabase.from('passkey_challenges').delete().eq('id', data.id);
  return data;
};
export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || req.body?.action || '');
    if (action === 'register-options' || action === 'register-verify') {
      const auth = await getDashboardUserFromRequest(req);
      if (!auth?.user?.id) return res.status(401).json({ error: 'سجّل دخولك بالإيميل الأول.' });
      const user = auth.user;
      if (action === 'register-options') {
        const { data: existing } = await supabase.from('passkey_credentials').select('credential_id').eq('auth_user_id', user.id);
        const options = await generateRegistrationOptions({ rpName: RP_NAME, rpID: RP_ID, userID: user.id, userName: user.email || user.id, userDisplayName: user.user_metadata?.full_name || 'مستخدم دبّر', attestationType: 'none', excludeCredentials: (existing || []).map((x) => ({ id: x.credential_id })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
        await saveChallenge(user.id, options.challenge, 'registration');
        return res.status(200).json(options);
      }
      const challenge = String(req.body?.challenge || '');
      const saved = await takeChallenge(challenge, 'registration', user.id);
      if (!saved) return res.status(400).json({ error: 'انتهت صلاحية الطلب. جرّب تفعيل البصمة تاني.' });
      const verification = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true });
      if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'لم نقدر نتحقق من Passkey.' });
      const info = verification.registrationInfo;
      await supabase.from('passkey_credentials').insert({ auth_user_id: user.id, credential_id: b64(info.credential.id), public_key: Buffer.from(info.credential.publicKey), counter: info.credential.counter, transports: req.body.response?.response?.transports || [] });
      return res.status(200).json({ ok: true });
    }
    if (action === 'login-options') {
      const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required', allowCredentials: [] });
      await saveChallenge(null, options.challenge, 'authentication');
      return res.status(200).json(options);
    }
    if (action === 'login-verify') {
      const challenge = String(req.body?.challenge || '');
      const saved = await takeChallenge(challenge, 'authentication');
      if (!saved) return res.status(400).json({ error: 'انتهت صلاحية الطلب. جرّب البصمة تاني.' });
      const credentialId = String(req.body?.response?.id || '');
      const { data: credential } = await supabase.from('passkey_credentials').select('*').eq('credential_id', credentialId).maybeSingle();
      if (!credential) return res.status(401).json({ error: 'الـPasskey ده مش مربوط بحساب دبّر.' });
      const verification = await verifyAuthenticationResponse({ response: req.body.response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, credential: { id: credential.credential_id, publicKey: Buffer.from(typeof credential.public_key === 'string' && credential.public_key.startsWith('\\\\x') ? credential.public_key.slice(2).match(/.{1,2}/g).map((x) => parseInt(x, 16)) : credential.public_key), counter: Number(credential.counter), transports: credential.transports || [] }, requireUserVerification: true });
      if (!verification.verified) return res.status(401).json({ error: 'تعذر التحقق من البصمة.' });
      await supabase.from('passkey_credentials').update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq('id', credential.id);
      const { data: authUser, error: authUserError } = await supabase.auth.admin.getUserById(credential.auth_user_id);
      if (authUserError || !authUser?.user?.email) return res.status(500).json({ error: 'تم التحقق من Passkey لكن تعذر فتح الجلسة.' });
      const { data: link, error: linkError } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: authUser.user.email, options: { redirectTo: `${ORIGIN}/app/dabbar-dashboard-full.html` } });
      if (linkError || !link?.properties?.action_link) return res.status(500).json({ error: 'تم التحقق من Passkey لكن تعذر فتح الجلسة.' });
      return res.status(200).json({ ok: true, actionLink: link.properties.action_link });
    }
    return res.status(400).json({ error: 'إجراء Passkey غير معروف.' });
  } catch (error) { console.error('passkey error:', error); return res.status(500).json({ error: 'حصل خطأ في إعداد Passkey.' }); }
}
