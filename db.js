// Tiny promise wrapper around IndexedDB. All data lives on this device only.

const DEFAULT_REP_MIN = 8;
const DEFAULT_REP_MAX = 12;
const DEFAULT_STEP = 5;

// Fill in fields added in version 2 (title, notes, setup notes, rep range,
// weight step) without touching anything that is already there.
function withDefaults(w) {
  const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  const exercises = (Array.isArray(w.exercises) ? w.exercises : []).map(e => {
    const repMin = posInt(e.repMin, DEFAULT_REP_MIN);
    const repMax = posInt(e.repMax, DEFAULT_REP_MAX);
    return {
      ...e,
      sets: Array.isArray(e.sets) ? e.sets : [],
      setupNote: typeof e.setupNote === 'string' ? e.setupNote : '',
      repMin: Math.min(repMin, repMax),
      repMax: Math.max(repMin, repMax),
      step: typeof e.step === 'number' && e.step > 0 ? e.step : DEFAULT_STEP,
    };
  });
  return {
    ...w,
    title: typeof w.title === 'string' ? w.title : '',
    notes: typeof w.notes === 'string' ? w.notes : '',
    exercises,
  };
}

const DB = (() => {
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('liftlog', 2);
        req.onupgradeneeded = e => {
          const db = req.result;
          if (!db.objectStoreNames.contains('workouts')) {
            db.createObjectStore('workouts', { keyPath: 'id' });
          } else if (e.oldVersion < 2) {
            // Version 1 -> 2: rewrite each saved workout with the new fields.
            const store = req.transaction.objectStore('workouts');
            store.openCursor().onsuccess = ev => {
              const cursor = ev.target.result;
              if (!cursor) return;
              cursor.update(withDefaults(cursor.value));
              cursor.continue();
            };
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => db.close(); // let a newer version of the app upgrade
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workouts', mode);
      const req = fn(tx.objectStore('workouts'));
      let result;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    all: () => run('readonly', s => s.getAll()).then(list => list.map(withDefaults)),
    put: w => run('readwrite', s => s.put(w)),
    del: id => run('readwrite', s => s.delete(id)),
    putMany: list => run('readwrite', s => { list.forEach(w => s.put(w)); }),
  };
})();
