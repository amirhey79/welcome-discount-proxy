// Next.js API route on Vercel: POST /api/subscribe
import crypto from 'crypto';
import nodemailer from 'nodemailer';

const {
  SHOPIFY_SHOP,                         // e.g. tiademau.myshopify.com
  SHOPIFY_ADMIN_API_VERSION = '2024-07',
  SHOPIFY_ADMIN_ACCESS_TOKEN,           // shpat_...
  APP_PROXY_SIGNING_SECRET,             // from App Proxy setup page
  EMAIL_FROM, SMTP_HOST, SMTP_PORT = '587', SMTP_USER, SMTP_PASS
} = process.env;

// --- verify Shopify App Proxy signature ---
function verifyProxySignature(req) {
  try {
    const url = new URL(`https://${req.headers.host}${req.url}`);
    const signature = url.searchParams.get('signature');
    if (!signature) return false;
    url.searchParams.delete('signature');
    const base = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '');
    const expected = crypto
      .createHmac('sha256', APP_PROXY_SIGNING_SECRET)
      .update(base, 'utf8')
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function shopifyGQL(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (!r.ok || data.errors) throw new Error(JSON.stringify(data.errors || data, null, 2));
  return data.data;
}

async function emailHasAnyOrders(email) {
  const q = `email:${email} AND (fulfillment_status:unfulfilled OR fulfillment_status:fulfilled)`;
  const query = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id } } } }`;
  const data = await shopifyGQL(query, { q });
  return data.orders.edges.length > 0;
}

function makeCode() {
  return 'WELCOME-' + crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. WELCOME-9F2A3C
}

async function createOneTimeTenPercent(code) {
  const mutation = `
    mutation($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode {
          codeDiscount { ... on DiscountCodeBasic { codes(first:1){ edges{ node{ code } } } } }
        }
        userErrors { field message }
      }
    }`;
  const input = {
    title: 'Welcome 10% - First Purchase',
    startsAt: new Date().toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { all: true },
    customerGets: { value: { percentage: 0.1 }, items: { all: true } },
    code
  };
  const out = await shopifyGQL(mutation, { input });
  const errs = out.discountCodeBasicCreate.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join(', '));
  return out.discountCodeBasicCreate.codeDiscountNode?.codeDiscount?.codes?.edges?.[0]?.node?.code || code;
}

async function getCustomerAndExistingCode(email) {
  const q = `query($q:String!){
    customers(first:1, query:$q) {
      edges { node { id email metafield(namespace:"welcome", key:"code"){ value } } }
    }
  }`;
  const data = await shopifyGQL(q, { q: `email:${email}` });
  const edge = data.customers.edges[0];
  if (edge) return { id: edge.node.id, existingCode: edge.node.metafield?.value || null };

  // create minimal customer if not found, so we can store a metafield
  const m = `mutation($input: CustomerInput!){
    customerCreate(input:$input){ customer{ id email } userErrors{ message field } }
  }`;
  const out = await shopifyGQL(m, { input: { email } });
  const errs = out.customerCreate.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join(', '));
  return { id: out.customerCreate.customer.id, existingCode: null };
}

async function setCustomerCodeMetafield(customerId, code) {
  const m = `mutation($m:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$m){ metafields{ id } userErrors{ field message } }
  }`;
  const vars = { m: [{
    ownerId: customerId,
    namespace: 'welcome',
    key: 'code',
    type: 'single_line_text_field',
    value: code
  }]};
  const out = await shopifyGQL(m, vars);
  const errs = out.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join(', '));
}

async function sendCodeEmail(to, code) {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6">
      <h2>Welcome to Tiadem 🎉</h2>
      <p>Your one-time <b>10% discount</b> code:</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:.1em">${code}</p>
      <p>Apply at checkout. Single use only.</p>
      <p><a href="https://tiadem.com.au">Shop now</a></p>
    </div>`;
  await transport.sendMail({ from: EMAIL_FROM, to, subject: 'Your 10% welcome code', html });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, message:'Method not allowed' });
    if (!verifyProxySignature(req)) return res.status(401).json({ ok:false, message:'Unauthorised' });

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok:false, message:'Please enter a valid email.' });
    }

    // already issued? (customer metafield)
    const { id: customerId, existingCode } = await getCustomerAndExistingCode(email);
    if (existingCode) {
      await sendCodeEmail(email, existingCode);
      return res.json({ ok:true, message:'Code already issued; re-sent to your email.' });
    }

    // block if any order exists (fulfilled or unfulfilled)
    if (await emailHasAnyOrders(email)) {
      return res.status(409).json({ ok:false, message:'Coupon codes are for first purchase only.' });
    }

    // mint random code (retry on collision)
    let code, ok = false, tries = 0;
    while (!ok && tries < 5) {
      tries++;
      try {
        code = makeCode();
        code = await createOneTimeTenPercent(code);
        ok = true;
      } catch (e) {
        if (!String(e.message).toLowerCase().includes('has already been taken')) throw e;
      }
    }
    if (!ok) throw new Error('Could not mint unique code');

    await setCustomerCodeMetafield(customerId, code);
    await sendCodeEmail(email, code);

    return res.json({ ok:true, message:'Your 10% code has been emailed.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:'Server error. Please try again later.' });
  }
}
