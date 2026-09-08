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
      // Номер замовлення — 11 цифр
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
      data.append('products', phpSerializeProducts(products));
      data.append('bayer_name', name);
      data.append('phone', phone);

      data.append('utm_source', cleanSource);
      data.append('utm_medium', cleanMedium);
      data.append('utm_campaign', cleanCampaign);
      data.append('utm_content', cleanContent);

      const lpcrmResponse = await fetch(
        'https://radiopark.lp-crm.biz/api/addNewOrder.html',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: data.toString()
        }
      );

      const lpcrmText = await lpcrmResponse.text();

      if (!lpcrmResponse.ok) {
        throw new Error(
          `LP-CRM HTTP ${lpcrmResponse.status}: ${lpcrmText}`
        );
      }

      console.log('LP-CRM response:', lpcrmText);

      lpcrmOk = true;
    } catch (error) {
      lpcrmError =
        error instanceof Error ? error.message : String(error);

      console.error('LP-CRM integration error:', lpcrmError);
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
            properties: ['firstname', 'phone'],
            limit: 1
          })
        }
      );

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        throw new Error(
          `HubSpot contact search failed: ${errorText}`
        );
      }

      const searchData = await searchResponse.json();
      let contactId = searchData.results?.[0]?.id;

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
          const errorText = await updateResponse.text();
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
          const errorText = await createResponse.text();
          throw new Error(
            `HubSpot contact create failed: ${errorText}`
          );
        }

        const contactData = await createResponse.json();
        contactId = contactData.id;
      }

      const pipelinesResponse = await fetch(
        'https://api.hubapi.com/crm/v3/pipelines/deals',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${hubspotToken}`
          }
        }
      );

      if (!pipelinesResponse.ok) {
        const errorText = await pipelinesResponse.text();
        throw new Error(
          `HubSpot pipeline lookup failed: ${errorText}`
        );
      }

      const pipelinesData = await pipelinesResponse.json();
      const pipelines = pipelinesData.results || [];

      const pipeline =
        pipelines.find(p => p.label === 'Sales Pipeline') ||
        pipelines.find(p => p.displayOrder === 0) ||
        pipelines[0];

      if (!pipeline) {
        throw new Error('HubSpot deal pipeline not found');
      }

      const stage =
        (pipeline.stages || []).find(
          s => s.label === 'Appointment Scheduled'
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
              dealname: `FASCIA GUN — ${name} — ${phone}`,
              amount: '539',
              pipeline: pipeline.id,
              dealstage: stage.id,
              closedate: new Date().toISOString(),
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
                  associationCategory: 'HUBSPOT_DEFINED',
                  associationTypeId: 3
                }]
              }
            ]
          })
        }
      );

      if (!dealResponse.ok) {
        const errorText = await dealResponse.text();
        throw new Error(
          `HubSpot deal create failed: ${errorText}`
        );
      }

      hubspotOk = true;
    } catch (error) {
      hubspotError =
        error instanceof Error ? error.message : String(error);

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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );

  const telegramResult = await telegramResponse.json();

  if (!telegramResponse.ok || !telegramResult.ok) {
    return res.status(502).json({
      ok: false,
      error: 'Telegram request failed'
    });
  }

  return res.status(200).json({
    ok: true,
    lpcrmOk,
    hubspotOk,
    ...(lpcrmError ? { lpcrmError } : {}),
    ...(hubspotError ? { hubspotError } : {})
  });
}
