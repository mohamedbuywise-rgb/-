import { getDashboardUserFromRequest } from '../../lib/dashboardAuth.js';
import { supabase } from '../../lib/supabaseClient.js';

const uid = () => -Math.floor(Math.random() * 9000000000000000) - 1;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const user = await getDashboardUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'سجّل الدخول أولاً.' });

  // getDashboardUserFromRequest يرجع authUserId، وليس كائن auth.users نفسه.
  // استخدام user.id هنا كان يمرر undefined إلى استعلام profiles، لذلك كان
  // التنزيل ينتهي برسالة أن التوكن غير جاهز حتى للمستخدم الذي لديه profile.
  const profileId = user.authUserId;
  // هذا endpoint يعمل على الخادم، وعميل Supabase هنا يستخدم service-role key
  // من إعدادات الخادم، لذلك لا يتعطل بسبب RLS أثناء إنشاء profile لأول مرة.
  // لا نستخدم access token الخاص بالمتصفح في عمليات قاعدة البيانات الخادمية.
  // نفس ضمان bank-accounts: لو كان هذا أول طلب للمستخدم، ينشئ Supabase
  // صف profile ويولّد sms_webhook_token من default في قاعدة البيانات.
  const { error: profileUpsertError } = await supabase
    .from('profiles')
    .upsert({ id: profileId }, { onConflict: 'id', ignoreDuplicates: true });
  if (profileUpsertError) {
    console.error('MACRODROID_PROFILE_UPSERT_ERROR', JSON.stringify(profileUpsertError));
    return res.status(500).json({ error: 'تعذر تجهيز إعدادات الأتمتة على الخادم. جرّب مرة أخرى.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('sms_webhook_token')
    .eq('id', profileId)
    .maybeSingle();

  if (profileError) {
    console.error('MACRODROID_PROFILE_LOOKUP_ERROR', JSON.stringify(profileError));
    return res.status(500).json({ error: 'تعذر جلب توكن الأتمتة من الخادم. جرّب مرة أخرى.' });
  }

  if (!profile?.sms_webhook_token) {
    return res.status(409).json({
      error: 'تعذر تجهيز توكن الأتمتة لحسابك. جرّب تحديث الصفحة، وإذا استمرت المشكلة تواصل مع الدعم الفني.',
    });
  }

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://www.dabbar.online').replace(/\/$/, '');
  const payload = JSON.stringify({
    token: String(profile.sms_webhook_token),
    sender: '[sms_sender]',
    text: '[sms_message]',
  });
  const macro = {
    globalVariables: [],
    macroExportVersion: 1,
    macro: {
      disabledTimestamp: 0,
      exportedActionBlocks: [],
      forceEvenIfNotEnabledTimestamp: 0,
      isActionBlock: false,
      isExtra: false,
      isFavourite: false,
      lastEditedTimestamp: Date.now(),
      localVariables: [],
      localVarsAlphabetical: true,
      m_GUID: uid(),
      m_actionList: [{
        requestConfig: {
          allowAnyCertificate: false,
          basicAuthEnabled: false,
          basicAuthPassword: '',
          basicAuthUsername: '',
          blockNextAction: true,
          clientCertEnabled: false,
          clientCertKeyStoreDisplayName: '',
          clientCertKeyStoreUri: '',
          clientCertPassword: '',
          contentBodyDynamicFileName: '',
          contentBodyFileDisplayName: '',
          contentBodyFileUri: '',
          contentBodyFolderDisplayName: '',
          contentBodyFolderUri: '',
          contentBodySource: 0,
          contentBodyText: payload,
          contentType: 'application/json',
          followRedirects: true,
          headerParams: [{ paramName: 'Content-Type', paramValue: 'application/json' }],
          localFileUri: '',
          prettifyJson: true,
          queryParams: [],
          requestTimeOutSeconds: 30,
          responseVariableName: 'responseBody',
          returnCodeVariableName: 'responseCode',
          saveResponseFileName: '',
          saveResponseFolderPathDisplayName: '',
          saveResponseFolderPathUri: '',
          saveResponseType: 0,
          saveReturnCodeToVariable: true,
          saveReturnHeadersToVariable: false,
          urlToOpen: `${baseUrl}/api/sms-webhook`,
          useLocalFileUri: false,
          useStaticContentBodyFile: true,
        },
        disableLogging: false,
        m_SIGUID: uid(),
        m_classType: 'HttpRequestAction',
        m_constraintList: [],
        m_isDisabled: false,
        m_isOrCondition: false,
      }],
      m_category: 'دبّر',
      m_constraintList: [],
      m_description: 'يرسل رسائل البنوك والمحافظ إلى دبّر. فعّل الماكرو وامنح MacroDroid إذن الإشعارات.',
      m_descriptionOpen: false,
      m_enabled: false,
      m_excludeLog: false,
      m_headingColor: -16711936,
      m_isOrCondition: false,
      m_name: 'دبّر — أتمتة رسائل البنوك',
      m_triggerList: [{
        enableRegex: true,
        enableRegexPhoneNumber: false,
        ignoreCase: true,
        isExcludeContact: false,
        m_exactMatch: false,
        m_excludes: false,
        m_groupIdList: [],
        m_groupNameList: [],
        m_option: 3,
        m_smsContent: 'EGP|جنيه|ج\\.م|USD|دولار|EUR|يورو|SAR|ريال|AED|درهم',
        m_smsFromList: [],
        m_smsNumberExclude: false,
        subscriptionId: -1,
        disableLogging: false,
        m_SIGUID: uid(),
        m_classType: 'IncomingSMSTrigger',
        m_comment: 'رسائل البنوك والمحافظ فقط',
        m_constraintList: [],
        m_isDisabled: false,
        m_isOrCondition: false,
      }],
    },
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daber-bank-automation.macro"');
  return res.status(200).send(JSON.stringify(macro));
}
