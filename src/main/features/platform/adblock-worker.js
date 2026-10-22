'use strict';
// Сборка движка блокировщика в отдельном потоке: скачать списки (EasyList, EasyPrivacy, uBlock…) и разобрать
// ~100 тыс. правил — это секунды процессора, main в это время должен оставаться отзывчивым.
// Результат — сериализованный движок (Uint8Array), main делает ElectronBlocker.deserialize.

const { parentPort } = require('worker_threads');

async function build() {
  const { FiltersEngine } = require('@ghostery/adblocker');
  const t0 = Date.now();
  const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
  const buf = engine.serialize();
  return { buf, ms: Date.now() - t0 };
}

build().then(({ buf, ms }) => {
  parentPort.postMessage({ ok: true, buf, ms }, [buf.buffer]);
}).catch((e) => {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
});
