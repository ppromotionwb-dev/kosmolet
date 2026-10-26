// SKU Ozon из ссылок /product/<название>-<sku>/. «Раз» — сколько раз SKU встречается на странице.
const ids = new Map();
for (const a of document.querySelectorAll('a[href*="/product/"]')) {
  let u;
  try { u = new URL(a.href); } catch (e) { continue; }
  const m = /\/product\/(?:[^/]*-)?(\d{5,})\/?$/.exec(u.pathname);
  if (!m) continue;
  const title = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const r = ids.get(m[1]);
  if (r) { r.n++; if (title.length > r.title.length) r.title = title; } else ids.set(m[1], { n: 1, title, url: u.origin + u.pathname });
}
const rows = [...ids].map(([id, r]) => [id, r.n, r.title, r.url]);
if (!rows.length) return 'SKU Ozon не найдено. Откройте поиск или каталог Ozon и прокрутите страницу.';
return { __kosmo: 'table', title: 'SKU: ' + rows.length, columns: ['SKU', 'Раз', 'Название', 'Ссылка'], rows, copyColumn: 0 };
