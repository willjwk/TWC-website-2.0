/*
 * TWC product variant handling.
 *
 * Liquid analog of useOptimisticVariant from
 * app/components/slices/SliceProductHero.tsx in the sibling Hydrogen
 * repo. On radio change, finds the matching variant in the embedded
 * variants JSON, updates the hidden id input, swaps image/price/ATC
 * via Shopify's Section Rendering API, and updates the URL so the
 * variant is shareable.
 */

(function () {
  function init(root) {
    if (!root || root.dataset.twcProductInit) return;
    root.dataset.twcProductInit = '1';

    var form = root.querySelector('form[action*="/cart/add"]');
    if (!form) return;

    var hiddenId = form.querySelector('[data-variant-id]');
    var atc = form.querySelector('[data-product-atc]');
    var atcLabel = atc && atc.querySelector('[data-atc-label]');
    var priceContainer = root.querySelector('[data-product-price]');
    var mediaContainer = root.querySelector('[data-product-media]');
    var variantsJsonNode = root.querySelector('[data-variants-json]');
    var sectionId = root.dataset.sectionId;
    var productHandle = root.dataset.productHandle;
    var hideAtc = root.dataset.hideAtc === 'true';

    var variants = [];
    try {
      variants = JSON.parse(variantsJsonNode.textContent);
    } catch (e) {
      console.warn('[twc-product] could not parse variants JSON', e);
      return;
    }

    function selectedOptionValues() {
      var options = [];
      var fieldsets = form.querySelectorAll('[data-option-position]');
      fieldsets.forEach(function (fs) {
        var checked = fs.querySelector('[data-option-input]:checked');
        if (checked) options.push(checked.value);
      });
      return options;
    }

    function findVariant(optionValues) {
      return variants.find(function (v) {
        return v.options.length === optionValues.length &&
          v.options.every(function (val, i) { return val === optionValues[i]; });
      });
    }

    function setAtc(variant) {
      if (!atc) return;
      var disabled = hideAtc || !variant || !variant.available;
      atc.disabled = disabled;
      if (atcLabel) {
        if (hideAtc) {
          atcLabel.textContent = 'Currently unavailable';
        } else if (!variant) {
          atcLabel.textContent = 'Unavailable';
        } else if (!variant.available) {
          atcLabel.textContent = 'Sold out';
        } else {
          atcLabel.textContent = 'Add to cart';
        }
      }
    }

    function pushUrl(variantId) {
      if (!variantId || !window.history || !window.history.replaceState) return;
      var url = new URL(window.location.href);
      url.searchParams.set('variant', variantId);
      window.history.replaceState({}, '', url.toString());
    }

    function fetchSection(variantId) {
      if (!sectionId || !productHandle) return null;
      var url = '/products/' + productHandle + '?section_id=' + encodeURIComponent(sectionId) + '&variant=' + variantId;
      return fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('section render ' + r.status);
        return r.text();
      });
    }

    function applySectionHtml(html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var newPrice = doc.querySelector('[data-product-price]');
      if (newPrice && priceContainer) {
        priceContainer.replaceWith(newPrice);
        priceContainer = newPrice;
      }
      var newMedia = doc.querySelector('[data-product-media]');
      if (newMedia && mediaContainer) {
        mediaContainer.replaceWith(newMedia);
        mediaContainer = newMedia;
        initMedia(root);
      }
    }

    function onOptionChange() {
      var values = selectedOptionValues();
      var variant = findVariant(values);

      if (hiddenId) hiddenId.value = variant ? variant.id : '';
      setAtc(variant);
      if (variant) pushUrl(variant.id);

      if (variant) {
        var p = fetchSection(variant.id);
        if (p) {
          p.then(applySectionHtml).catch(function (e) {
            console.warn('[twc-product] section render failed', e);
          });
        }
      }
    }

    form.addEventListener('change', function (e) {
      if (e.target && e.target.matches('[data-option-input]')) {
        onOptionChange();
      }
    });

    initMedia(root);
  }

  /*
   * initMedia — carousel + video autoplay enforcement for the product
   * hero. Mirrors the video↔image carousel and `enforceMutedAndAutoPlay`
   * helper from app/components/slices/SliceProductHero.tsx in the
   * sibling Hydrogen repo. Idempotent: a `data-media-init` flag on the
   * media element guards against double-binding when called repeatedly
   * (e.g. after Section Rendering API replaces the media subtree).
   */
  function initMedia(root) {
    var media = root.querySelector('[data-product-media]');
    if (!media || media.dataset.mediaInit === '1') return;
    media.dataset.mediaInit = '1';

    var video = media.querySelector('[data-twc-video]');

    function playVideo() {
      if (!video) return;
      video.muted = true;
      video.defaultMuted = true;
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }

    playVideo();

    if (media.dataset.canCarousel !== 'true') return;

    function setSlide(name) {
      media.dataset.currentSlide = name;
      if (name === 'video') playVideo();
    }
    function next() {
      setSlide(media.dataset.currentSlide === 'video' ? 'image' : 'video');
    }
    function prev() {
      setSlide(media.dataset.currentSlide === 'image' ? 'video' : 'image');
    }

    media.addEventListener('click', function (e) {
      if (e.target.closest('[data-media-prev]')) {
        e.preventDefault();
        prev();
      } else if (e.target.closest('[data-media-next]')) {
        e.preventDefault();
        next();
      }
    });
    media.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      }
    });
  }

  function bootAll() {
    document.querySelectorAll('.twc-product').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }

  // Re-init on Shopify theme editor section reload
  document.addEventListener('shopify:section:load', function (e) {
    var root = e.target && e.target.querySelector('.twc-product');
    if (root) init(root);
  });
})();
