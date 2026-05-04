#!/usr/bin/env node
/*
 * Clones products from the TWC live store into the dev store, including
 * title, description, options, variants, media (images + videos), and
 * all custom.* metafields. Re-uploads file_reference metafield targets
 * so dev-store URLs are self-contained (not pinned to the live CDN).
 *
 * Required env:
 *   LIVE_STORE  — e.g. "the-whatsupp-co"
 *   LIVE_TOKEN  — Admin API token on live store with read_products + read_files
 *                 (or any token with broader scopes; we only call read queries)
 *   DEV_STORE   — e.g. "twc-v2-dev-store"
 *   DEV_TOKEN   — Admin API token on dev store with write_products + write_files
 *
 * Usage:
 *   LIVE_STORE=the-whatsupp-co LIVE_TOKEN=shpat_xxx \
 *   DEV_STORE=twc-v2-dev-store DEV_TOKEN=shpat_yyy \
 *   node scripts/clone-products.mjs <handle> [<handle> ...]
 *
 * Skipped on purpose:
 *   - Judge.me synced metafields (jmproductrating, jmtotalreviews,
 *     latest_reviews) — sync those via the Judge.me app once installed
 *   - Metaobject-reference metafields (benefits, tickertape, stickers,
 *     related_products) — those need their target metaobject types to
 *     exist on the dev store, deferred to Phase 4
 *   - Selling plans / subscription groups
 *   - Inventory tracking (variants are created with tracked=false)
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
const SKIP_METAFIELD_KEYS = new Set([
  'jmproductrating',
  'jmtotalreviews',
  'latest_reviews',
  'benefits',
  'tickertape',
  'stickers',
  'related_products',
]);

const liveEndpoint = `https://${LIVE_STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
const devEndpoint = `https://${DEV_STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

async function gql(endpoint, token, query, variables) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
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

const live = (q, v) => gql(liveEndpoint, LIVE_TOKEN, q, v);
const dev = (q, v) => gql(devEndpoint, DEV_TOKEN, q, v);

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
      status
      options { id name position values }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          barcode
          selectedOptions { name value }
        }
      }
      media(first: 50) {
        nodes {
          mediaContentType
          alt
          ... on MediaImage {
            image { url altText width height }
          }
          ... on Video {
            sources { url mimeType width height format }
          }
        }
      }
      metafields(first: 100) {
        nodes {
          namespace
          key
          type
          value
          reference {
            ... on MediaImage {
              id
              image { url altText }
            }
          }
        }
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
      files {
        id
        fileStatus
        ... on MediaImage { id }
      }
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
  return sources.reduce((a, b) => {
    const aSize = (a.width || 0) * (a.height || 0);
    const bSize = (b.width || 0) * (b.height || 0);
    return bSize > aSize ? b : a;
  });
}

async function cloneOne(handle) {
  console.log(`\n→ ${handle}`);

  // 1. Read from live
  const liveData = await live(READ_PRODUCT, { handle });
  const product = liveData.productByHandle;
  if (!product) {
    console.error(`  ✗ no product with handle "${handle}" on live`);
    return false;
  }
  console.log(`  read: "${product.title}" (${product.variants.nodes.length} variants, ${product.media.nodes.length} media, ${product.metafields.nodes.length} metafields)`);

  // 2. Create product on dev (options only, no variants yet)
  const productInput = {
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: 'ACTIVE',
    productOptions: product.options.map((o) => ({
      name: o.name,
      position: o.position,
      values: o.values.map((v) => ({ name: v })),
    })),
  };

  const createRes = await dev(PRODUCT_CREATE, { input: productInput });
  if (createRes.productCreate.userErrors.length) {
    console.error(`  ✗ productCreate: ${JSON.stringify(createRes.productCreate.userErrors)}`);
    return false;
  }
  const devProduct = createRes.productCreate.product;
  console.log(`  created: ${devProduct.handle} (${devProduct.id})`);

  // 3. Bulk-create variants (replacing the auto-generated standalone variant)
  if (product.variants.nodes.length > 0) {
    const variantsInput = product.variants.nodes.map((v) => ({
      sku: v.sku || null,
      price: v.price,
      compareAtPrice: v.compareAtPrice || null,
      barcode: v.barcode || null,
      optionValues: v.selectedOptions.map((o) => ({
        optionName: o.name,
        name: o.value,
      })),
      inventoryItem: { tracked: false },
    }));
    const vRes = await dev(VARIANTS_BULK_CREATE, {
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
    const mRes = await dev(MEDIA_CREATE, {
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

  // 5. Re-upload file_reference metafield targets, build a key→new-fileGid map
  const fileGidByKey = {};
  const fileRefMetas = product.metafields.nodes.filter(
    (m) =>
      m.namespace === 'custom' &&
      m.type === 'file_reference' &&
      m.reference?.image?.url &&
      !SKIP_METAFIELD_KEYS.has(m.key)
  );
  for (const m of fileRefMetas) {
    const fRes = await dev(FILE_CREATE, {
      files: [
        {
          originalSource: m.reference.image.url,
          alt: m.reference.image.altText || `${m.key} for ${product.handle}`,
        },
      ],
    });
    if (fRes.fileCreate.userErrors.length) {
      console.error(`  ✗ fileCreate (${m.key}): ${JSON.stringify(fRes.fileCreate.userErrors)}`);
      continue;
    }
    const file = fRes.fileCreate.files[0];
    fileGidByKey[m.key] = file.id;
    console.log(`  file: ${m.key} uploaded as ${file.id}`);
  }

  // 6. Set custom metafields on the new product
  const metafieldsInput = [];
  for (const m of product.metafields.nodes) {
    if (m.namespace !== 'custom') continue;
    if (SKIP_METAFIELD_KEYS.has(m.key)) continue;
    if (m.type === 'list.metaobject_reference' || m.type === 'metaobject_reference') continue;

    let value = m.value;
    if (m.type === 'file_reference') {
      const newGid = fileGidByKey[m.key];
      if (!newGid) continue;
      value = newGid;
    }

    metafieldsInput.push({
      ownerId: devProduct.id,
      namespace: 'custom',
      key: m.key,
      type: m.type,
      value,
    });
  }

  if (metafieldsInput.length > 0) {
    const sRes = await dev(METAFIELDS_SET, { metafields: metafieldsInput });
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
