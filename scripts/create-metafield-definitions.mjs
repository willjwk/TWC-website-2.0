#!/usr/bin/env node
/*
 * Creates the 13 Phase-3 TWC product metafield definitions on a Shopify
 * store. Idempotent — re-running treats existing definitions as success.
 *
 * Required env:
 *   SHOPIFY_STORE  — e.g. "twc-v2-dev-store" (no .myshopify.com suffix)
 *   SHOPIFY_TOKEN  — Admin API access token from a custom app on the
 *                    store. Required scope: `write_products` (for
 *                    product-owned metafield definitions; NOT
 *                    `write_metaobject_definitions` which only covers
 *                    metaobject types). Token starts with `shpat_`.
 *
 * Usage (PowerShell):
 *   $env:SHOPIFY_STORE = "twc-v2-dev-store"
 *   $env:SHOPIFY_TOKEN = "shpat_xxxxx"
 *   node scripts/create-metafield-definitions.mjs
 *
 * Usage (bash):
 *   SHOPIFY_STORE=twc-v2-dev-store \
 *   SHOPIFY_TOKEN=shpat_xxxxx \
 *   node scripts/create-metafield-definitions.mjs
 *
 * The 4 metaobject-reference fields (benefits, tickertape, stickers,
 * related_products) are deferred to Phase 4 — they require their target
 * metaobject types to exist first.
 */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;

if (!STORE || !TOKEN) {
  console.error('Missing env. Set SHOPIFY_STORE and SHOPIFY_TOKEN.');
  process.exit(1);
}

const API_VERSION = '2024-10';
const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

const MUTATION = `#graphql
  mutation Create($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        type { name }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const definitions = [
  {
    name: 'Strapline',
    namespace: 'custom',
    key: 'strapline',
    description: 'Tagline shown on product cards.',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Short description',
    namespace: 'custom',
    key: 'short_description',
    description: 'Short blurb shown next to the price on the product hero.',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Product subtitle',
    namespace: 'custom',
    key: 'product_subtitle',
    description: 'Sub-line below the product price.',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Primary colour',
    namespace: 'custom',
    key: 'primary_colour',
    description: 'Drives the product page gradient. Pick one.',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
    validations: [
      {
        name: 'choices',
        value: JSON.stringify(['Pink', 'Green', 'Purple', 'LightPink']),
      },
    ],
  },
  {
    name: 'Product background image',
    namespace: 'custom',
    key: 'product_background',
    description: 'Background image shown behind the portrait product image when a video carousel is present.',
    type: 'file_reference',
    ownerType: 'PRODUCT',
    validations: [
      { name: 'file_type_options', value: JSON.stringify(['Image']) },
    ],
  },
  {
    name: 'CTA sticker',
    namespace: 'custom',
    key: 'cta_sticker',
    description: 'Sticker badge rendered near the add-to-cart button.',
    type: 'file_reference',
    ownerType: 'PRODUCT',
    validations: [
      { name: 'file_type_options', value: JSON.stringify(['Image']) },
    ],
  },
  {
    name: 'Hide add to cart',
    namespace: 'custom',
    key: 'hide_add_to_cart',
    description: 'When ON, disables the add-to-cart button (e.g. coming-soon products).',
    type: 'boolean',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Hide product page',
    namespace: 'custom',
    key: 'hide_product_page',
    description: 'Not enforced at runtime by the theme. Use a Shopify URL redirect to send hidden products to /. Kept for parity with the Hydrogen data model.',
    type: 'boolean',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Benefits (Accordion: BENEFITS)',
    namespace: 'custom',
    key: 'what_is_it_',
    description: 'Rich text — populates the BENEFITS accordion tab on the product hero.',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Ingredients',
    namespace: 'custom',
    key: 'ingredients',
    description: 'Rich text — populates the INGREDIENTS accordion tab on the product hero.',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'How to use',
    namespace: 'custom',
    key: 'how_to_use',
    description: 'Rich text — populates the HOW TO USE accordion tab on the product hero.',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: '5 things to know',
    namespace: 'custom',
    key: 'five_things_to_know',
    description: 'Rich text — populates the 5 THINGS TO KNOW accordion tab on the product hero.',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Shipping and returns',
    namespace: 'custom',
    key: 'shipping_and_returns',
    description: 'Rich text — populates the SHIPPING & RETURNS accordion tab on the product hero.',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
  },
];

async function gql(query, variables) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${r.statusText}: ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function isAlreadyExistsError(userErrors) {
  if (!userErrors || userErrors.length === 0) return false;
  return userErrors.some(
    (e) =>
      e.code === 'TAKEN' ||
      e.code === 'PRESENT' ||
      (e.message && e.message.toLowerCase().includes('already')) ||
      (e.message && e.message.toLowerCase().includes('taken'))
  );
}

async function createOne(def) {
  const label = `${def.namespace}.${def.key}`;
  let data;
  try {
    data = await gql(MUTATION, { definition: def });
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    return { ok: false, label };
  }
  const result = data.metafieldDefinitionCreate;
  if (result.userErrors && result.userErrors.length > 0) {
    if (isAlreadyExistsError(result.userErrors)) {
      console.log(`  ✓ ${label} (already exists, skipped)`);
      return { ok: true, label, skipped: true };
    }
    console.error(`  ✗ ${label}: ${JSON.stringify(result.userErrors)}`);
    return { ok: false, label };
  }
  console.log(`  ✓ ${label} (created)`);
  return { ok: true, label, created: true };
}

(async () => {
  console.log(`Creating ${definitions.length} metafield definitions on ${STORE}.myshopify.com (API ${API_VERSION})…`);
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const def of definitions) {
    const result = await createOne(def);
    if (!result.ok) failed += 1;
    else if (result.skipped) skipped += 1;
    else if (result.created) created += 1;
  }
  console.log('');
  console.log(`Done. ${created} created, ${skipped} already-existed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
