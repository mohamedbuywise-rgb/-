// ============================================================================
// طابور الكتابة اليدوية Offline — دبّر
// ----------------------------------------------------------------------------
// الفكرة: الكتابة اليدوية بس (فورم "إدخال يدوي سريع"، مصروف/دخل/دين) هي اللي بتشتغل
// من غير نت، لأنها مش محتاجة تحليل AI. الكتابة الذكية والصوت والفاتورة لازم نت دايمًا.
//
// لو مفيش نت وقت الحفظ (أو الطلب فشل لسبب شبكة)، العملية بتتخزن في IndexedDB على الجهاز
// (مش على السيرفر)، وبتفضل "معلّقة" لحد ما النت يرجع. أول ما يرجع، بتتبعت تلقائيًا،
// وتتسجل عادي وتظهر بعدها في تليجرام وعلى كل الأجهزة.
//
// اللي بيحصل التلقائي:
//   - أول ما الصفحة تتفتح ولقيت نت.
//   - أول ما جهاز يرجعله النت (حدث 'online').
//   - لما التاب يرجع يبقى ظاهر (visibilitychange) والنت موجود.
// وفيه زرار "زامن الآن" يدوي في البانر لو المستخدم عايز يجرب فورًا.
// ============================================================================
(function () {
  const DB_NAME = 'dabbar-offline';
  const DB_VERSION = 1;
  const STORE = 'pending_manual_entries';
  const MAX_ATTEMPTS_BEFORE_FLAG = 5;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('indexedDB_unsupported')); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'localId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexedDB_open_failed'));
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('indexedDB_tx_failed'));
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB_request_failed'));
    });
  }

  function newLocalId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ---------- عمليات الطابور ----------
  async function enqueue(entry) {
    const record = {
      localId: newLocalId(),
      kind: entry.kind, // 'financial-action' | 'manual-debt'
      payload: entry.payload,
      label: entry.label || '',
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
    };
    await withStore('readwrite', (store) => store.add(record));
    return record;
  }

  async function getAllPending() {
    const rows = await withStore('readonly', (store) => reqToPromise(store.getAll()));
    return (rows || []).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function removeEntry(localId) {
    await withStore('readwrite', (store) => store.delete(localId));
  }

  async function bumpAttempt(localId, entry, errorMessage) {
    const updated = { ...entry, attempts: (entry.attempts || 0) + 1, lastError: errorMessage || null };
    await withStore('readwrite', (store) => store.put(updated));
    return updated;
  }

  function endpointFor(kind) {
    if (kind === 'manual-debt') return '/api?route=manual-debt';
    return '/api?route=financial-actions';
  }

  // نميّز بين "مفيش نت" (نوقف كل المحاولات ونستنى) و"السيرفر رفض الطلب" (نكمل للي بعده
  // ونعلّم العملية دي عشان تراجعها بنفسك، لأن إعادة نفس الطلب مش هتنجح لوحدها).
  function isNetworkFailure(error) {
    return error instanceof TypeError || error?.message === 'Failed to fetch' || !navigator.onLine;
  }

  let flushing = false;
  const listeners = new Set();
  function notify(state) { listeners.forEach((fn) => { try { fn(state); } catch { /* تجاهل */ } }); }

  async function computeState() {
    let rows = [];
    try { rows = await getAllPending(); } catch { /* IndexedDB مش متاح — نعتبره فاضي */ }
    return { count: rows.length, failedCount: rows.filter((r) => r.attempts >= MAX_ATTEMPTS_BEFORE_FLAG).length, rows };
  }

  async function refreshUI() { notify(await computeState()); }

  // ---------- المزامنة ----------
  async function flushQueue({ accessToken } = {}) {
    if (flushing) return { synced: 0, failed: 0, stopped: 'already_running' };
    if (!navigator.onLine) { await refreshUI(); return { synced: 0, failed: 0, stopped: 'offline' }; }
    flushing = true;
    let synced = 0;
    let failed = 0;
    let stopped = null;
    try {
      const rows = await getAllPending();
      for (const entry of rows) {
        try {
          const response = await fetch(endpointFor(entry.kind), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken || ''}` },
            body: JSON.stringify(entry.payload),
          });
          if (response.ok) { await removeEntry(entry.localId); synced += 1; continue; }
          // السيرفر رفض الطلب (400/401/...) — مش مشكلة شبكة، إعادة المحاولة مش هتنجح لوحدها
          const data = await response.json().catch(() => ({}));
          await bumpAttempt(entry.localId, entry, data.error || `HTTP ${response.status}`);
          failed += 1;
        } catch (error) {
          if (isNetworkFailure(error)) { stopped = 'offline'; break; } // النت راح تاني: نوقف ونكمل بعدين
          await bumpAttempt(entry.localId, entry, error?.message || 'خطأ غير متوقع');
          failed += 1;
        }
      }
    } finally {
      flushing = false;
      await refreshUI();
    }
    return { synced, failed, stopped };
  }

  function onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  window.DabbarOfflineQueue = { enqueue, getAllPending, removeEntry, flushQueue, refreshUI, onStateChange, isNetworkFailure };
})();
