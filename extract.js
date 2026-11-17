// Shopify -> Pathao order bridge.
//
// Rebuilt from observed runtime logs and commit-message history of the
// original service after its GitHub repo became inaccessible. Behavior is
// matched as closely as the logs allowed, but this is a reconstruction, not
// a restored original — verify amount_to_collect against real orders before
// fully trusting it with COD money.
const crypto = require('crypto');
const express = require('express');

const {
  PORT = 3000,
  SHOP,
  SHOPIFY_API_VERSION,
  SHOPIFY_WEBHOOK_SECRET,
  PATHAO_BASE_URL,
  PATHAO_CLIENT_ID,
  PATHAO_CLIENT_SECRET,
  PATHAO_USERNAME,
  PATHAO_PASSWORD,
  PATHAO_GRANT_TYPE = 'password',
  MERCHANT_STORE_ID,
} = process.env;

const app = express();

// Keep the raw body around so the Shopify HMAC can be verified against the
// exact bytes Shopify signed, not a re-serialized copy.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const serverStartedAt = new Date();

console.log(`🕒 Server started at: ${serverStartedAt.toISOString()}`);
console.log('Orders created before this time will be skipped by the webhook.');
console.log('============================================');
console.log('🚀 SHOPIFY → PATHAO BRIDGE');
console.log('============================================');
console.log(`🌐 Port: ${PORT}`);
console.log(`🏪 Shopify: ${SHOP}`);
console.log(`📡 Shopify API: ${SHOPIFY_API_VERSION}`);
console.log('🚚 Pathao: PRODUCTION');
console.log(`🏬 Pathao Store ID: ${MERCHANT_STORE_ID}`);
console.log(`🕒 Cutoff: orders before ${serverStartedAt.toISOString()} will be skipped`);
console.log('🔔 Webhook: POST /webhooks/orders-create');
console.log('============================================');

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !req.rawBody) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// Bangladeshi numbers arrive as 880XXXXXXXXXX or +880XXXXXXXXXX; Pathao wants
// the local 0XXXXXXXXXX form.
function normalizePhone(raw) {
  if (!raw) return '';
  let phone = String(raw).replace(/[^\d+]/g, '');
  if (phone.startsWith('+880')) phone = '0' + phone.slice(4);
  else if (phone.startsWith('880')) phone = '0' + phone.slice(3);
  return phone;
}

function buildAddress(shippingAddress) {
  if (!shippingAddress) return '';
  return [
    shippingAddress.address1,
    shippingAddress.address2,
    shippingAddress.city,
    shippingAddress.province,
  ]
    .filter(Boolean)
    .join(', ');
}

function buildItemDescription(lineItems) {
  return (lineItems || [])
    .map((item) => `${item.name} x ${item.quantity}`)
    .join(', ');
}

function totalWeightKg(lineItems) {
  const grams = (lineItems || []).reduce(
    (sum, item) => sum + (Number(item.grams) || 0) * (Number(item.quantity) || 1),
    0
  );
  const kg = grams / 1000;
  // No min/max clamp here on purpose — a prior commit on the original
  // service explicitly removed Pathao's default 0.5-10kg weight
  // constraints. Guard only against a literal zero, which Pathao rejects.
  return kg > 0 ? kg : 0.5;
}

// Paid orders need nothing collected on delivery; everything else (COD,
// partially paid) collects whatever Shopify still shows as outstanding.
function amountToCollect(order) {
  if (order.financial_status === 'paid') return 0;
  const outstanding = order.total_outstanding ?? order.current_total_price ?? order.total_price;
  return Math.max(0, Math.round(parseFloat(outstanding || '0') ));
}

async function getPathaoAccessToken() {
  console.log('🔐 Requesting Pathao access token...');
  const res = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PATHAO_CLIENT_ID,
      client_secret: PATHAO_CLIENT_SECRET,
      grant_type: PATHAO_GRANT_TYPE,
      username: PATHAO_USERNAME,
      password: PATHAO_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error('Pathao auth failed'), { response: data });
  }
  console.log('✅ Pathao access token obtained');
  return data.access_token;
}

async function createPathaoOrder(payload, accessToken) {
  const res = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

app.post('/webhooks/orders-create', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.log('❌ Shopify webhook signature verification failed');
    return res.status(401).send('invalid signature');
  }
  console.log('✅ Shopify webhook signature verified');

  const order = req.body;
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const topic = req.get('X-Shopify-Topic');
  const shop = req.get('X-Shopify-Shop-Domain');

  console.log('============================================');
  console.log(`Webhook ID: ${webhookId}`);
  console.log(`Topic: ${topic}`);
  console.log(`Shop: ${shop}`);
  console.log(`🛒 Shopify Order ID: ${order.id}`);
  console.log(`🧾 Shopify Order Name: ${order.name}`);

  // Always ack 200 fast so Shopify doesn't retry; everything below is best
  // effort against Pathao.
  res.status(200).send('ok');

  const ALLOWED_SOURCES = ['web', 'shopify_draft_order'];
  if (!ALLOWED_SOURCES.includes(order.source_name)) {
    console.log(`⏭️ Order ${order.id} ignored`);
    console.log(`Source: ${order.source_name}`);
    console.log(`Only source_name in [${ALLOWED_SOURCES.join(', ')}] is allowed`);
    return;
  }

  const createdAt = new Date(order.created_at);
  if (createdAt < serverStartedAt) {
    console.log(
      `⏭️ Skipping old order (created ${order.created_at}, before server start ${serverStartedAt.toISOString()})`
    );
    return;
  }

  const shipping = order.shipping_address || order.customer?.default_address;
  const payload = {
    store_id: Number(MERCHANT_STORE_ID),
    merchant_order_id: order.name,
    recipient_name: shipping?.name || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
    recipient_phone: normalizePhone(shipping?.phone || order.customer?.phone || order.phone),
    recipient_address: buildAddress(shipping),
    delivery_type: 48,
    item_type: 2,
    special_instruction: order.note || '',
    item_quantity: (order.line_items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0),
    item_weight: totalWeightKg(order.line_items),
    item_description: buildItemDescription(order.line_items),
    amount_to_collect: amountToCollect(order),
  };

  console.log('📦 PATHAO ORDER PAYLOAD');
  console.log(JSON.stringify(payload, null, 2));
  console.log('🚚 Sending order to Pathao...');

  try {
    const token = await getPathaoAccessToken();
    const { ok, data } = await createPathaoOrder(payload, token);

    if (ok && data?.data?.consignment_id) {
      console.log('============================================');
      console.log('✅ SHOPIFY → PATHAO SUCCESS');
      console.log('============================================');
      console.log(
        JSON.stringify(
          {
            success: true,
            shopify_order_id: order.id,
            merchant_order_id: order.name,
            shopify_order_name: order.name,
            order_status: 'Pending',
            consignment_id: data.data.consignment_id,
            pathao_response: {
              type: data.type,
              message: data.message,
              delivery_fee: data.data.delivery_fee,
            },
          },
          null,
          2
        )
      );
    } else {
      console.log('❌ PATHAO ORDER CREATION FAILED');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.log('❌ PATHAO ORDER CREATION FAILED');
    console.log(JSON.stringify(err.response || { message: err.message }, null, 2));
  }
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
