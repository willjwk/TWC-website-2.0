# TWC theme (Dawn-based)

This repo is a Shopify Online Store 2.0 Liquid theme for **The Whats Upp**, started from **Shopify Dawn v15.4.1** (upstream remote: `https://github.com/Shopify/dawn.git`). It is replacing a Hydrogen storefront in the sibling repo `../twc-website-rewrite/`.

The full migration plan lives at `C:\Users\willi\.claude\plans\take-a-look-at-sorted-bird.md`.

## Why this exists

The sibling Hydrogen build ships an internal "SliceMachine" page builder driven by `custom.slices` metafields referencing metaobjects. Migration goals:
- Reuse Shopify apps via theme app blocks (Judge.me, Klaviyo, AWIN, etc.).
- Hand off content editing to non-devs via the theme editor.
- Drop Oxygen + Remix maintenance overhead.

## Active surface

Only build / customize templates for: `index.json`, `page.json`, `page.<handle>.json` as needed, `product.json`, `cart.json`, `404.liquid`. Collections, blogs, search, customer accounts, policies stay disabled — Shopify URL redirects send them to `/`. Do not invest time in `templates/collection.json`, `blog.json`, `article.json`, `search.json`, `customers/*`, `list-collections.json`.

`/cart/{lines}` and `/discount/{code}` are native Shopify URLs — no work.

## Slice → section mapping

Source components in sibling repo: `../twc-website-rewrite/app/components/slices/`.

| Slice (React) | Section (Liquid) | Source |
|---|---|---|
| SliceHero | `sections/hero-video.liquid` | **build** (Dawn `video.liquid` doesn't do desktop/mobile responsive sources) |
| SliceText | `sections/rich-text.liquid` | Dawn stock |
| SliceTwoColumn | `sections/image-with-text.liquid` | Dawn stock |
| SliceCards | `sections/multicolumn.liquid` (or custom `cards.liquid`) | Dawn stock-ish |
| SliceFAQs | `sections/collapsible-content.liquid` | Dawn stock |
| SliceTestimonials | `sections/testimonial-carousel.liquid` | **build** (Splide) |
| SliceComparison | `sections/comparison-table.liquid` | **build** |
| SliceReviews | Judge.me theme app block | App |
| SliceSocialCarousel | `sections/social-carousel.liquid` | **build** |
| SliceProducts | `sections/featured-products.liquid` | **build** (subscription toggle) |
| SliceTickertape | `sections/marquee.liquid` | **build** |
| SlicePatchtech (+Duplicate) | `sections/patchtech.liquid` (one section, two presets) | **build** |
| SliceProductHero | folded into `sections/main-product.liquid` | customize Dawn |
| SliceStickers | `sections/stickers.liquid` | **build** |
| SliceContactForm | `sections/contact-form.liquid` | Dawn stock + reCAPTCHA + dual-post to Pipedream |

## Content authoring

Moving from metaobject-referenced slices to **theme-editor section blocks** (decision recorded in plan). A one-time export script will read `custom.slices` from existing pages/products via Admin GraphQL and emit JSON template files to seed `templates/*.json` so we don't re-author 50+ pages by hand.

Product-bound metafields stay as metafields and are surfaced via dynamic source bindings on section settings:
- `custom.primary_colour` — inline CSS var on product wrapper
- `custom.strapline`, `custom.short_description` — text settings
- `custom.cta_sticker` — sticker block
- `custom.hide_add_to_cart` — conditionally hide ATC
- `custom.hide_product_page` — enforced via Shopify URL redirects per hidden product (Liquid has no clean runtime redirect)

## Cart specifics

- AJAX cart drawer (Dawn ships one).
- Discount panel: post to native `/discount/{code}` and read `cart.cart_level_discount_applications`.
- Quantity-triggered upsell ("Buy 3 packs / 15% off"): UI in custom `cart-upsell.liquid` reading cart state in JS. **The 15% must be enforced by a Shopify automatic discount (Buy X Get Y)** — never compute in JS, or cart and checkout will diverge.
- Country selector: Dawn's built-in `{% form 'localization' %}` — drop the custom React `CountrySelector`.

## Multi-currency / i18n

Use **Shopify Markets**, not URL-prefix routing. Configure GB primary (£), US (USD), ES (EUR). Markets handles `/en-us` / `/en-es` URLs automatically. No `($locale)` shim, no `app/lib/i18n.ts` equivalent.

## Integrations (where each lives)

| Integration | Where |
|---|---|
| Judge.me | App theme block, drop into `main-product` |
| Klaviyo | Klaviyo theme app extension; replaces React `SignupForm` |
| GTM `GTM-KRPQQDJ6` | Inline in `layout/theme.liquid` |
| reCAPTCHA v2 | Inline in `sections/contact-form.liquid` |
| AWIN advertiser `113918` | `layout/theme.liquid` + Customer Events Web Pixel for order confirmation |
| Conversion pixel `bZebgbtblt` (`conversion.thewhatsupp.com`) | Customer Events Web Pixel |
| Instagram feed | Instafeed-style Shopify app, OR Cloudflare Worker fallback |
| Pipedream contact form | Dual-post: Shopify `{% form 'contact' %}` + JS POST to Pipedream webhook |
| Pipedream newsletter | Dropped — Klaviyo native handles signup |

## Sibling Hydrogen build (reference only)

`../twc-website-rewrite/` is the source-of-truth for visual fidelity and behavior. Read these when building each section:

- `app/routes/($locale).products.$handle.jsx` — product loader, metafields, slice composition
- `app/routes/($locale)._index.jsx`, `app/routes/($locale).pages.$handle.jsx` — page templates
- `app/components/slices/Slice*.tsx` — visual reference per slice
- `app/components/CartUpsell.jsx`, `CartUpsellItem.jsx` — upsell UI logic (ignore the JS discount math; use Shopify automatic discount)
- `app/components/CartMain.jsx` — cart drawer composition
- `app/styles/_variables.scss`, `mixins.scss`, `index.scss` — design tokens to lift into `config/settings_schema.json` + `assets/base.css` `:root` custom properties
- `app/root.jsx` — every inline integration script needs an equivalent in `layout/theme.liquid`
- `app/data/countries.js` — Markets config reference

## Out of scope for this theme

- Custom React/Remix code anywhere.
- Server-side API routes — `api.contact.ts`, `api.newsletter.ts`, `api.instafeed.ts` do not move; their replacements are listed in the integrations table above.
- The `ReviewForm` Pipedream-bearer flow — leave alone (user decision).
