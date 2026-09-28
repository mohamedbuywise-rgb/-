/*
 * Dabbar Offline-First data layer
 * - IndexedDB snapshot cache for the complete dashboard payload.
 * - Scoped by Supabase auth user id so data is never mixed between accounts.
 * - localStorage remains a small compatibility fallback for older installations.
 */
(function () {
  'use strict';
  const DB_NAME = 'dabbar-offline-data';
  const DB_VERSION = 1;
  const SNAPSHOTS = 'snapshots';
  const META = 'meta';
  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('indexeddb_unsupported'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
    });
    return dbPromise;
  }

  async function put(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('indexeddb_write_failed'));
    });
  }

  async function get(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('indexeddb_read_failed'));
    });
  }

  async function saveDashboard(userId, data) {
    if (!userId || !data) return;
    const key = `dashboard:${userId}`;
    const record = { key, userId, data, savedAt: Date.now(), schemaVersion: 1 };
    try { await put(SNAPSHOTS, record); } catch (error) { console.warn('DABBAR_IDB_SAVE_FAILED', error); }
    // Keep the old cache as a last-resort fallback for browsers with broken IDB storage.
    try {
      const raw = JSON.stringify(data);
      if (raw.length < 4000000) localStorage.setItem(`dabbar-dashboard-cache-${userId}`, raw);
    } catch (_) {}
  }

  async function readDashboard(userId) {
    if (!userId) return null;
    try {
      const record = await get(SNAPSHOTS, `dashboard:${userId}`);
      if (record?.data) return { data: record.data, savedAt: record.savedAt || 0, source: 'indexeddb' };
    } catch (error) { console.warn('DABBAR_IDB_READ_FAILED', error); }
    try {
      const data = JSON.parse(localStorage.getItem(`dabbar-dashboard-cache-${userId}`) || 'null');
      return data ? { data, savedAt: 0, source: 'localstorage' } : null;
    } catch (_) { return null; }
  }

  async function saveMeta(key, value) {
    try { await put(META, { key, value, savedAt: Date.now() }); } catch (_) {}
  }
  async function readMeta(key) {
    try { return (await get(META, key))?.value ?? null; } catch (_) { return null; }
  }

  window.DabbarOfflineStore = { saveDashboard, readDashboard, saveMeta, readMeta };
})();
