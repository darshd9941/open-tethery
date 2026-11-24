// Product name for display. The helper serves /product.json (from the repo's product.json);
// the static HTML and these defaults are only the fallback if that fetch fails.
export const brand = { name: 'Pocket Monitor', shortName: 'Pocket Monitor' };

export function applyBrand(doc = document) {
  doc.title = brand.name;
  for (const el of doc.querySelectorAll('[data-brand]')) el.textContent = brand[el.dataset.brand] || el.textContent;
  for (const el of doc.querySelectorAll('[data-brand-text]')) el.textContent = el.dataset.brandText.replace('{name}', brand.name);
  const m = doc.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (m) m.setAttribute('content', brand.shortName);
}

export async function loadBrand(fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl('/product.json', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j.name === 'string' && j.name) {
        brand.name = j.name;
        brand.shortName = typeof j.shortName === 'string' && j.shortName ? j.shortName : j.name;
      }
    }
  } catch { /* keep the fallback */ }
  if (typeof document !== 'undefined') applyBrand();
  return brand;
}
