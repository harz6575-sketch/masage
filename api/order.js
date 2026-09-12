import { createHash } from 'node:crypto';

function clean(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizePhone(phone) {
  const value = clean(phone, 64).replace(/[^\d+]/g, '');
  if (!value) return '';
  if (value.startsWith('00')) return value.slice(2);
  return value.replace(/^\+/, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function findValueDeep(value, keys, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }

  if (typeof value !== 'object') return '';

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(value, key) &&
      value[key] !== undefined &&
      value[key] !== null &&
      value[key] !== ''
    ) {
      return value[key];
    }
  }

  for (const child of Object.values(value)) {
    const found = findValueDeep(child, keys, depth + 1);
    if (found) return found;
  }

  return '';
}

function getMetaEventName(status) {
  const s = String(status || '').toLowerCase().trim();

  // LP-CRM status ID 11 = "Прийнятий"
  if (s === '11') {
    return 'QualifiedLead';
  }

  if (
    s.includes('заверш') ||
    s.includes('викуп') ||
    s.includes('оплач') ||
    s.includes('купив')
  ) {
    return 'Purchase';
  }

  if (
    s.includes('підтверд') ||
    s.includes('подтверд') ||
    s.includes('прийнят') ||
    s.includes('підтверж') ||
    s.includes('qualif')
  ) {
    return 'QualifiedLead';
  }

  return null;
}

async function handleLpcrmWebhook(req, res) {
  const expectedSecret = process.env.LPCRM_WEBHOOK_SECRET;
  const receivedSecret =
    req.query?.secret ||
    req.headers['x-lpcrm-secret'] ||
    '';

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized webhook'
    });
  }

 
const body = req.body || {};

console.log(
  'LPCRM WEBHOOK DEBUG:',
  JSON.stringify(body, (key, value) => {
    const k = String(key).toLowerCase();

    if (
      k.includes('phone') ||
      k.includes('email') ||
      k.includes('name') ||
      k.includes('address') ||
      k.includes('token') ||
      k.includes('password')
    ) {
      return '[REDACTED]';
    }

    return value;
  })
);
  const status = findValueDeep(body, [
    'status',
    'order_status',
    'status_name',
    'statusName',
    'new_status',
    'newStatus',
    'status_title',
    'statusTitle'
  ]);

  const eventName = getMetaEventName(status);

  if (!eventName) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: 'CRM status is not a Meta conversion stage',
      status: status || null
    });
  }

  const phone = findValueDeep(body, [
    'phone',
    'bayer_phone',
    'buyer_phone',
    'client_phone',
    'customer_phone',
    'telephone'
  ]);

  const email = findValueDeep(body, [
    'email',
    'bayer_email',
    'buyer_email',
    'client_email',
    'customer_email'
  ]);

  const leadId = findValueDeep(body, [
    'lead_id',
    'leadId',
    'leadid',
    'facebook_lead_id',
    'fb_lead_id'
  ]);

  const orderId = findValueDeep(body, [
    'order_id',
    'orderId',
    'id'
  ]);

  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = clean(email, 200).toLowerCase();

  if (!normalizedPhone && !normalizedEmail && !leadId) {
    console.error('LP-CRM webhook: no customer identifier', body);

    return res.status(400).json({
      ok: false,
      error: 'No phone, email or lead_id in LP-CRM webhook payload'
    });
  }

  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({
      ok: false,
      error: 'META_CAPI_ACCESS_TOKEN is not configured'
    });
  }

  const userData = {};

  if (normalizedPhone) {
    userData.ph = [sha256(normalizedPhone)];
  }

  if (normalizedEmail) {
    userData.em = [sha256(normalizedEmail)];
  }

  if (leadId) {
    userData.lead_id = String(leadId);
  }

  const customData = {
    event_source: 'crm',
    lead_event_source: 'LP-CRM'
  };

  if (status) {
    customData.crm_status = clean(status, 160);
  }

  if (orderId) {
    customData.crm_order_id = clean(orderId, 120);
  }

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    user_data: userData,
    custom_data: customData
  };

  const payload = {
    data: [event]
  };

  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  const datasetId =
    process.env.META_DATASET_ID || '941779558385090';

  const apiVersion =
    process.env.META_API_VERSION || 'v26.0';

  const metaResponse = await fetch(
    `https://graph.facebook.com/${apiVersion}/${datasetId}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const metaResult = await metaResponse.json().catch(() => ({}));

  if (!metaResponse.ok || metaResult.error) {
    console.error('Meta CAPI error:', metaResult);

    return res.status(502).json({
      ok: false,
      error: 'Meta Conversions API request failed',
      meta: metaResult
    });
  }

  console.log('Meta CAPI event sent:', {
    eventName,
    status,
    orderId
  });

  return res.status(200).json({
    ok: true,
    sentToMeta: true,
    eventName,
    status: status || null,
    orderId: orderId || null
  });
}

function phpSerializeProducts(products) {
  const phpString = (value) => {
    const str = String(value);

    return `s:${Buffer.byteLength(str, 'utf8')}:"${str}";`;
  };

  const serializeArray = (arr) => {
    let result = `a:${arr.length}:{`;

    arr.forEach((item, index) => {
      result += `i:${index};`;

      if (Array.isArray(item)) {
        result += serializeArray(item);
      } else {
        const keys = Object.keys(item);

        result += `a:${keys.length}:{`;

        for (const key of keys) {
          result += phpString(key);

          const value = item[key];

          if (Array.isArray(value)) {
            result += serializeArray(value);
          } else {
            result += phpString(value);
          }
        }

        result += '}';
      }
    });

    result += '}';

    return result;
  };

  return encodeURIComponent(serializeArray(products));
}

export default async function handler(req, res) {

  // =========================
  // LP-CRM WEBHOOK → META CAPI
  // =========================

  if (req.method === 'POST' && req.query?.secret) {
    return handleLpcrmWebhook(req, res);
  }

  // =========================
  // WEBSITE ORDER
  // =========================

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  const {
    name,
    phone,
    source,
    medium,
    campaign,
    content
  } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({
      ok: false,
      error: 'Missing fields'
    });
  }

  // =========================
  // ENV VARIABLES
  // =========================

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

  const lpcrmKey = process.env.LPCRM_API_KEY;
  const lpcrmProductId = process.env.LPCRM_PRODUCT_ID;

  if (!telegramToken || !chatId) {
    return res.status(500).json({
      ok: false,
      error: 'Telegram is not configured'
    });
  }

  const cleanSource = source || 'Прямий перехід';
  const cleanMedium = medium || '—';
  const cleanCampaign = campaign || '—';
  const cleanContent = content || '—';

  // =========================
  // LP-CRM
  // =========================

  let lpcrmOk = false;
  let lpcrmError = null;

  if (lpcrmKey && lpcrmProductId) {
    try {

      const orderId = String(
        Math.floor(10000000000 + Math.random() * 90000000000)
      );

      const products = [
        {
          product_id: lpcrmProductId,
          price: '539',
          count: '1',
          subs: []
        }
      ];

      const data = new URLSearchParams();

      data.append('key', lpcrmKey);
      data.append('order_id', orderId);
      data.append('country', 'UA');
      data.append(
        'products',
        phpSerializeProducts(products)
      );
      data.append('bayer_name', name);
      data.append('phone', phone);
      data.append(
        'site',
        'https://massage.cmoval.store'
      );

      data.append('utm_source', cleanSource);
      data.append('utm_medium', cleanMedium);
      data.append('utm_campaign', cleanCampaign);
      data.append('utm_content', cleanContent);

      const lpcrmResponse = await fetch(
        'https://radiopark.lp-crm.biz/api/addNewOrder.html',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded'
          },
          body: data.toString()
        }
      );

      const lpcrmText =
        await lpcrmResponse.text();

      if (!lpcrmResponse.ok) {
        throw new Error(
          `LP-CRM HTTP ${lpcrmResponse.status}: ${lpcrmText}`
        );
      }

      console.log(
        'LP-CRM response:',
        lpcrmText
      );

      lpcrmOk = true;

    } catch (error) {

      lpcrmError =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        'LP-CRM integration error:',
        lpcrmError
      );
    }
  }

  // =========================
  // HUBSPOT
  // =========================

  let hubspotOk = false;
  let hubspotError = null;

  if (hubspotToken) {
    try {

      const hsHeaders = {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json'
      };

      const searchResponse = await fetch(
        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          method: 'POST',
          headers: hsHeaders,
          body: JSON.stringify({
            filterGroups: [{
              filters: [{
                propertyName: 'phone',
                operator: 'EQ',
                value: phone
              }]
            }],
            properties: [
              'firstname',
              'phone'
            ],
            limit: 1
          })
        }
      );

      if (!searchResponse.ok) {
        const errorText =
          await searchResponse.text();

        throw new Error(
          `HubSpot contact search failed: ${errorText}`
        );
      }

      const searchData =
        await searchResponse.json();

      let contactId =
        searchData.results?.[0]?.id;

      if (contactId) {

        const updateResponse = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          {
            method: 'PATCH',
            headers: hsHeaders,
            body: JSON.stringify({
              properties: {
                firstname: name,
                phone
              }
            })
          }
        );

        if (!updateResponse.ok) {
          const errorText =
            await updateResponse.text();

          throw new Error(
            `HubSpot contact update failed: ${errorText}`
          );
        }

      } else {

        const createResponse = await fetch(
          'https://api.hubapi.com/crm/v3/objects/contacts',
          {
            method: 'POST',
            headers: hsHeaders,
            body: JSON.stringify({
              properties: {
                firstname: name,
                phone
              }
            })
          }
        );

        if (!createResponse.ok) {
          const errorText =
            await createResponse.text();

          throw new Error(
            `HubSpot contact create failed: ${errorText}`
          );
        }

        const contactData =
          await createResponse.json();

        contactId = contactData.id;
      }

      const pipelinesResponse =
        await fetch(
          'https://api.hubapi.com/crm/v3/pipelines/deals',
          {
            method: 'GET',
            headers: {
              Authorization:
                `Bearer ${hubspotToken}`
            }
          }
        );

      if (!pipelinesResponse.ok) {
        const errorText =
          await pipelinesResponse.text();

        throw new Error(
          `HubSpot pipeline lookup failed: ${errorText}`
        );
      }

      const pipelinesData =
        await pipelinesResponse.json();

      const pipelines =
        pipelinesData.results || [];

      const pipeline =
        pipelines.find(
          p => p.label === 'Sales Pipeline'
        ) ||
        pipelines.find(
          p => p.displayOrder === 0
        ) ||
        pipelines[0];

      if (!pipeline) {
        throw new Error(
          'HubSpot deal pipeline not found'
        );
      }

      const stage =
        (pipeline.stages || []).find(
          s => s.label ===
            'Appointment Scheduled'
        ) ||
        (pipeline.stages || []).find(
          s => s.displayOrder === 0
        ) ||
        pipeline.stages?.[0];

      if (!stage) {
        throw new Error(
          `No stage found in pipeline ${pipeline.label}`
        );
      }

      const dealResponse = await fetch(
        'https://api.hubapi.com/crm/v3/objects/deals',
        {
          method: 'POST',
          headers: hsHeaders,
          body: JSON.stringify({
            properties: {
              dealname:
                `FASCIA GUN — ${name} — ${phone}`,

              amount: '539',

              pipeline:
                pipeline.id,

              dealstage:
                stage.id,

              closedate:
                new Date().toISOString(),

              description: [
                `Телефон: ${phone}`,
                `Джерело: ${cleanSource}`,
                `Канал: ${cleanMedium}`,
                `Кампанія: ${cleanCampaign}`,
                `Оголошення: ${cleanContent}`
              ].join(' | ')
            },

            associations: [
              {
                to: {
                  id: contactId
                },

                types: [{
                  associationCategory:
                    'HUBSPOT_DEFINED',

                  associationTypeId: 3
                }]
              }
            ]
          })
        }
      );

      if (!dealResponse.ok) {
        const errorText =
          await dealResponse.text();

        throw new Error(
          `HubSpot deal create failed: ${errorText}`
        );
      }

      hubspotOk = true;

    } catch (error) {

      hubspotError =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        'HubSpot integration error:',
        hubspotError
      );
    }
  }

  // =========================
  // TELEGRAM
  // =========================

  const text = [
    '🔥 НОВА ЗАЯВКА — FASCIA GUN',
    '',
    `👤 Ім'я: ${name}`,
    `📞 Телефон: ${phone}`,
    '📦 Товар: Перкусійний масажер для тіла',
    '💰 Ціна: 539 грн',
    `📊 Джерело: ${cleanSource}`,
    `🎯 Кампанія: ${cleanCampaign}`,
    `📣 Канал: ${cleanMedium}`,
    `🧩 Оголошення: ${cleanContent}`,
    '',
    `LP-CRM: ${lpcrmOk ? '✅' : '❌'}`,
    `HubSpot: ${hubspotOk ? '✅' : '❌'}`
  ].join('\n');

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${telegramToken}/sendMessage`,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );

  const telegramResult =
    await telegramResponse.json();

  if (
    !telegramResponse.ok ||
    !telegramResult.ok
  ) {
    return res.status(502).json({
      ok: false,
      error: 'Telegram request failed'
    });
  }

  return res.status(200).json({
    ok: true,
    lpcrmOk,
    hubspotOk,

    ...(lpcrmError
      ? { lpcrmError }
      : {}),

    ...(hubspotError
      ? { hubspotError }
      : {})
  });
}
