#!/usr/bin/env node
/*
 * Clones products from the TWC live store into the dev store, including
 * title, description, options, variants, media (images + videos), and
 * all custom.* metafields. Re-uploads file_reference metafield targets
 * so dev-store URLs are self-contained.
 *
 * Reads from the live store via the Storefront API (because the
 * existing PRIVATE_STOREFRONT_API_TOKEN in the Hydrogen .env is a
 * private storefront token despite its `shpat_` prefix — it cannot
 * call Admin API endpoints). Writes to the dev store via Admin API.
 *
 * Required env:
 *   LIVE_STORE  — e.g. "the-whatsupp-co"
 *   LIVE_TOKEN  — Private storefront API token from the live store
 *                 (PRIVATE_STOREFRONT_API_TOKEN in twc-website-rewrite/.env)
 *   DEV_STORE   — e.g. "twc-v2-dev-store"
 *   DEV_TOKEN   — Admin API access token on the dev store with
 *                 write_products + write_files
 *
 * Usage:
 *   LIVE_STORE=the-whatsupp-co LIVE_TOKEN=shpat_xxx \
 *   DEV_STORE=twc-v2-dev-store DEV_TOKEN=shpat_yyy \
 *   node scripts/clone-products.mjs <handle> [<handle> ...]
 *
 * Skipped on purpose:
 *   - Judge.me synced metafields (sync separately once Judge.me app is installed)
 *   - Metaobject-reference fields (Phase 4)
 *   - Selling plans / subscription groups
 *   - Inventory tracking (variants tracked: false)
 */

const LIVE_STORE = process.env.LIVE_STORE;
const LIVE_TOKEN = process.env.LIVE_TOKEN;
const DEV_STORE = process.env.DEV_STORE;
const DEV_TOKEN = process.env.DEV_TOKEN;

const handles = process.argv.slice(2);

if (!LIVE_STORE || !LIVE_TOKEN || !DEV_STORE || !DEV_TOKEN) {
  console.error('Missing env. Need LIVE_STORE, LIVE_TOKEN, DEV_STORE, DEV_TOKEN.');
  process.exit(1);
}
if (handles.length === 0) {
  console.error('Pass one or more product handles as args.');
  process.exit(1);
}

const API_VERSION = '2024-10';

// All scalar / rich-text / boolean metafield keys to copy.
const SCALAR_METAFIELD_KEYS = [
  'strapline',
  'short_description',
  'product_subtitle',
  'primary_colour',
  'hide_add_to_cart',
  'hide_product_page',
  'what_is_it_',
  'ingredients',
  'how_to_use',
  'five_things_to_know',
  'shipping_and_returns',
];
const FILE_REF_METAFIELD_KEYS = ['cta_sticker', 'product_background'];

const liveEndpoint = `https://${LIVE_STORE}.myshopify.com/api/${API_VERSION}/graphql.json`;
const devEndpoint = `https://${DEV_STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

async function gqlPost(endpoint, headers, query, variables) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 400)}`);
  }
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const liveGql = (q, v) =>
  gqlPost(liveEndpoint, { 'Shopify-Storefront-Private-Token': LIVE_TOKEN }, q, v);
const devGql = (q, v) =>
  gqlPost(devEndpoint, { 'X-Shopify-Access-Token': DEV_TOKEN }, q, v);

// Storefront API has no "list all metafields" — query each one explicitly.
const READ_PRODUCT = `#graphql
  query Read($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
      descriptionHtml
      vendor
      productType
      tags
      options { name values }
      variants(first: 100) {
        nodes {
          sku
          availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          selectedOptions { name value }
        }
      }
      media(first: 50) {
        nodes {
          mediaContentType
          alt
          ... on MediaImage { image { url altText width height } }
          ... on Video { sources { url mimeType width height format } }
        }
      }
      strapline: metafield(namespace: "custom", key: "strapline") { type value }
      short_description: metafield(namespace: "custom", key: "short_description") { type value }
      product_subtitle: metafield(namespace: "custom", key: "product_subtitle") { type value }
      primary_colour: metafield(namespace: "custom", key: "primary_colour") { type value }
      hide_add_to_cart: metafield(namespace: "custom", key: "hide_add_to_cart") { type value }
      hide_product_page: metafield(namespace: "custom", key: "hide_product_page") { type value }
      what_is_it_: metafield(namespace: "custom", key: "what_is_it_") { type value }
      ingredients: metafield(namespace: "custom", key: "ingredients") { type value }
      how_to_use: metafield(namespace: "custom", key: "how_to_use") { type value }
      five_things_to_know: metafield(namespace: "custom", key: "five_things_to_know") { type value }
      shipping_and_returns: metafield(namespace: "custom", key: "shipping_and_returns") { type value }
      cta_sticker: metafield(namespace: "custom", key: "cta_sticker") {
        type
        value
        reference { ... on MediaImage { id image { url altText } } }
      }
      product_background: metafield(namespace: "custom", key: "product_background") {
        type
        value
        reference { ... on MediaImage { id image { url altText } } }
      }
    }
  }
`;

const PRODUCT_CREATE = `#graphql
  mutation Create($input: ProductInput!) {
    productCreate(input: $input) {
      product { id handle options { id name position } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_CREATE = `#graphql
  mutation V($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id title }
      userErrors { field message }
    }
  }
`;

const MEDIA_CREATE = `#graphql
  mutation M($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id } ... on Video { id } }
      mediaUserErrors { field message }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation F($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus ... on MediaImage { id } }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation S($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message }
    }
  }
`;

function bestVideoSource(sources) {
  if (!sources || sources.length === 0) return null;
  // productCreateMedia only accepts MP4 originals, not HLS (.m3u8) playlists.
  const mp4 = sources.filter(
    (s) => s.format === 'mp4' || s.mimeType === 'video/mp4'
  );
  if (mp4.length === 0) return null;
  return mp4.reduce((a, b) => {
    const aSize = (a.width || 0) * (a.height || 0);
    const bSize = (b.width || 0) * (b.height || 0);
    return bSize > aSize ? b : a;
  });
}

async function cloneOne(handle) {
  console.log(`\n→ ${handle}`);

  // 1. Read from live (Storefront API)
  const liveData = await liveGql(READ_PRODUCT, { handle });
  const product = liveData.productByHandle;
  if (!product) {
    console.error(`  ✗ no product with handle "${handle}" on live`);
    return false;
  }

  const scalarMetas = [];
  for (const key of SCALAR_METAFIELD_KEYS) {
    const m = product[key];
    if (m && m.value != null && m.value !== '') {
      scalarMetas.push({ key, type: m.type, value: m.value });
    }
  }
  const fileRefMetas = [];
  for (const key of FILE_REF_METAFIELD_KEYS) {
    const m = product[key];
    if (m && m.reference?.image?.url) {
      fileRefMetas.push({
        key,
        type: m.type,
        url: m.reference.image.url,
        alt: m.reference.image.altText || '',
      });
    }
  }
  const totalMetas = scalarMetas.length + fileRefMetas.length;

  console.log(`  read: "${product.title}" (${product.variants.nodes.length} variants, ${product.media.nodes.length} media, ${totalMetas} metafields)`);

  // 2. Create product on dev (options only, no variants yet)
  const productInput = {
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: 'ACTIVE',
    productOptions: product.options.map((o, i) => ({
      name: o.name,
      position: i + 1,
      values: o.values.map((v) => ({ name: v })),
    })),
  };

  const createRes = await devGql(PRODUCT_CREATE, { input: productInput });
  if (createRes.productCreate.userErrors.length) {
    console.error(`  ✗ productCreate: ${JSON.stringify(createRes.productCreate.userErrors)}`);
    return false;
  }
  const devProduct = createRes.productCreate.product;
  console.log(`  created: ${devProduct.handle} (${devProduct.id})`);

  // 3. Bulk-create variants (replacing the auto standalone variant)
  if (product.variants.nodes.length > 0) {
    const variantsInput = product.variants.nodes.map((v) => ({
      price: v.price?.amount,
      compareAtPrice: v.compareAtPrice?.amount || null,
      optionValues: v.selectedOptions.map((o) => ({
        optionName: o.name,
        name: o.value,
      })),
      inventoryItem: { tracked: false, sku: v.sku || null },
    }));
    const vRes = await devGql(VARIANTS_BULK_CREATE, {
      productId: devProduct.id,
      variants: variantsInput,
      strategy: 'REMOVE_STANDALONE_VARIANT',
    });
    if (vRes.productVariantsBulkCreate.userErrors.length) {
      console.error(`  ✗ variants: ${JSON.stringify(vRes.productVariantsBulkCreate.userErrors)}`);
    } else {
      console.log(`  variants: ${vRes.productVariantsBulkCreate.productVariants.length} created`);
    }
  }

  // 4. Add media
  const mediaInput = [];
  for (const m of product.media.nodes) {
    if (m.mediaContentType === 'IMAGE' && m.image?.url) {
      mediaInput.push({
        originalSource: m.image.url,
        mediaContentType: 'IMAGE',
        alt: m.alt || m.image.altText || '',
      });
    } else if (m.mediaContentType === 'VIDEO') {
      const src = bestVideoSource(m.sources);
      if (src?.url) {
        mediaInput.push({
          originalSource: src.url,
          mediaContentType: 'VIDEO',
          alt: m.alt || '',
        });
      }
    }
  }
  if (mediaInput.length > 0) {
    const mRes = await devGql(MEDIA_CREATE, {
      productId: devProduct.id,
      media: mediaInput,
    });
    const errs = mRes.productCreateMedia.mediaUserErrors;
    if (errs.length) {
      console.error(`  ✗ media: ${JSON.stringify(errs)}`);
    } else {
      console.log(`  media: ${mRes.productCreateMedia.media.length} queued (Shopify processes async)`);
    }
  }

  // 5. Re-upload file_reference metafield targets. Non-fatal — if the
  //    dev token lacks write_files scope, file metafields just don't
  //    set on dev, but everything else still clones.
  const fileGidByKey = {};
  for (const meta of fileRefMetas) {
    try {
      const fRes = await devGql(FILE_CREATE, {
        files: [
          {
            originalSource: meta.url,
            alt: meta.alt || `${meta.key} for ${product.handle}`,
          },
        ],
      });
      if (fRes.fileCreate.userErrors.length) {
        console.error(`  ! fileCreate (${meta.key}): ${JSON.stringify(fRes.fileCreate.userErrors)} — skipping`);
        continue;
      }
      const file = fRes.fileCreate.files[0];
      fileGidByKey[meta.key] = file.id;
      console.log(`  file: ${meta.key} uploaded as ${file.id}`);
    } catch (e) {
      console.error(`  ! fileCreate (${meta.key}) failed: ${e.message.slice(0, 160)} — skipping`);
    }
  }

  // 6. Set custom metafields on the new product
  const metafieldsInput = [];
  for (const meta of scalarMetas) {
    metafieldsInput.push({
      ownerId: devProduct.id,
      namespace: 'custom',
      key: meta.key,
      type: meta.type,
      value: meta.value,
    });
  }
  for (const meta of fileRefMetas) {
    const newGid = fileGidByKey[meta.key];
    if (!newGid) continue;
    metafieldsInput.push({
      ownerId: devProduct.id,
      namespace: 'custom',
      key: meta.key,
      type: meta.type,
      value: newGid,
    });
  }

  if (metafieldsInput.length > 0) {
    const sRes = await devGql(METAFIELDS_SET, { metafields: metafieldsInput });
    if (sRes.metafieldsSet.userErrors.length) {
      console.error(`  ✗ metafieldsSet: ${JSON.stringify(sRes.metafieldsSet.userErrors)}`);
    } else {
      console.log(`  metafields: ${sRes.metafieldsSet.metafields.length} set`);
    }
  }

  console.log(`  ✓ done — preview: https://${DEV_STORE}.myshopify.com/products/${devProduct.handle}`);
  return true;
}

(async () => {
  let ok = 0;
  let failed = 0;
  for (const handle of handles) {
    try {
      const success = await cloneOne(handle);
      if (success) ok += 1;
      else failed += 1;
    } catch (e) {
      console.error(`  ✗ ${handle}: ${e.message}`);
      failed += 1;
    }
  }
  console.log(`\nDone. ${ok} cloned, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
