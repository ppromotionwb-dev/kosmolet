'use strict';
// JSON-хранилища в userData: атомарная запись (tmp + rename), дебаунс 300 мс, flush при выходе.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEBOUNCE_MS = 300;
const registry = new Set();

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function renameWithRetry(tmp, file) {
  // На Windows rename иногда ловит EPERM/EBUSY из-за антивируса — пробуем ещё пару раз.
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* короткое ожидание */ }
    }
  }
}

function createStoreFactory(dir, log) {
  // Одно хранилище на файл: повторный ctx.store('x') возвращает тот же объект,
  // иначе два экземпляра перезаписывали бы файл друг друга.
  const instances = new Map();
  function createStore(name, defaults = {}, opts = {}) {
    const file = path.join(dir, name.endsWith('.json') ? name : name + '.json');
    const existing = instances.get(file.toLowerCase());
    if (existing) return existing;
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);
    let data;
    let timer = null;
    let dirty = false;
    let writing = Promise.resolve();
    // Версии записей: асинхронная запись не должна перетереть более новую синхронную (flush при выходе).
    let version = 0;
    let lastWritten = 0;

    try {
      const raw = fs.readFileSync(file, 'utf8');
      data = JSON.parse(raw);
      if (isPlainObject(defaults) && isPlainObject(data) && opts.mergeDefaults !== false) {
        data = Object.assign(clone(defaults), data);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Битый файл — сохраняем копию и начинаем с дефолтов.
        try { fs.copyFileSync(file, file + '.bad-' + Date.now()); } catch (_) {}
        if (log) log('store', `файл ${path.basename(file)} повреждён, взяты значения по умолчанию:`, e.message);
      }
      data = clone(defaults);
    }

    function serialize() {
      return JSON.stringify(data, null, opts.pretty === false ? 0 : 2);
    }

    function writeSync() {
      const v = ++version;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-s';
      fs.writeFileSync(tmp, serialize(), 'utf8');
      renameWithRetry(tmp, file);
      lastWritten = v;
    }

    async function writeAsync() {
      const v = ++version;
      const text = serialize();
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-a';
      await fs.promises.writeFile(tmp, text, 'utf8');
      if (lastWritten > v) { fs.promises.unlink(tmp).catch(() => {}); return; }
      renameWithRetry(tmp, file);
      lastWritten = v;
    }

    function schedule() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!dirty) return;
        dirty = false;
        writing = writing.then(writeAsync).catch((e) => {
          if (log) log('store', `ошибка записи ${path.basename(file)}:`, e.message);
        });
      }, opts.debounceMs ?? DEBOUNCE_MS);
    }

    const store = {
      file,
      get() { return data; },
      set(obj) {
        data = obj;
        schedule();
        emitter.emit('change', data);
        return data;
      },
      patch(fnOrObj) {
        if (typeof fnOrObj === 'function') {
          const res = fnOrObj(data);
          if (res !== undefined) data = res;
        } else if (isPlainObject(fnOrObj)) {
          Object.assign(data, fnOrObj);
        }
        schedule();
        emitter.emit('change', data);
        return data;
      },
      on(event, cb) { emitter.on(event, cb); return () => emitter.off(event, cb); },
      off(event, cb) { emitter.off(event, cb); },
      flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!dirty) return;
        dirty = false;
        try { writeSync(); } catch (e) {
          if (log) log('store', `ошибка flush ${path.basename(file)}:`, e.message);
        }
      },
      // Немедленная синхронная запись (без проверки dirty).
      saveNow() { dirty = true; store.flush(); },
    };
    registry.add(store);
    instances.set(file.toLowerCase(), store);
    return store;
  }

  createStore.flushAll = () => { for (const s of registry) s.flush(); };
  createStore.dir = dir;
  return createStore;
}

module.exports = { createStoreFactory, clone, isPlainObject };
