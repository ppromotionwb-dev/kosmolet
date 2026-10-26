// Артикулы Wildberries (nmId) из ссылок /catalog/<id>/detail.aspx и карточек товаров.
// «Раз» — сколько раз артикул встречается. Товары в поиске подгружаются при прокрутке.
const ids = new Map();
const add = (id, title) => {
  const r = ids.get(id);
  if (r) { r.n++; if (title.length > r.title.length) r.title = title; } else ids.set(id, { n: 1, title });
};
for (const a of document.querySelectorAll('a[href*="/catalog/"]')) {
  const m = /\/catalog\/(\d{4,})\/detail\.aspx/.exec(a.href);
  if (m) add(m[1], (a.getAttribute('aria-label') || a.title || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150));
}
for (const el of document.querySelectorAll('[data-nm-id]')) {
  const id = el.getAttribute('data-nm-id');
  if (/^\d{4,}$/.test(id) && !ids.has(id)) add(id, '');
}
const rows = [...ids].map(([id, r]) => [id, r.n, r.title, 'https://www.wildberries.ru/catalog/' + id + '/detail.aspx']);
if (!rows.length) return 'Артикулов WB не найдено. Откройте поиск или каталог Wildberries и прокрутите страницу.';
return { __kosmo: 'table', title: 'Артикулов: ' + rows.length, columns: ['nmId', 'Раз', 'Название', 'Ссылка'], rows, copyColumn: 0 };
