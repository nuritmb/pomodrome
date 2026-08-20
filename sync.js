// Sync layer. Two interchangeable backends behind one interface, so the timer
// UI never knows or cares whether state is shared.
//
//   store.mode           -> "firebase" | "local"
//   store.now()          -> epoch ms, corrected for this machine's clock skew
//   store.onState(fn)    -> fn({ timer, presets, presence, sessions }) on change
//   store.onStatus(fn)   -> fn({ connected, error })
//   store.setTimer(t)
//   store.setPresets(p)
//   store.announce(name) -> join the room's presence list under this name
//   store.logSession(k,v)-> record one completed work run

import { firebaseConfig, DATA_VERSION } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.18.0";

export const DEFAULT_PRESETS = {
  focus:  { name: "Focus",       seconds: 25 * 60, order: 0, builtin: true, work: true },
  deep:   { name: "Deep Work",   seconds: 50 * 60, order: 1, builtin: true, work: true },
  short:  { name: "Short break", seconds:  5 * 60, order: 2, builtin: true, work: false },
  long:   { name: "Long break",  seconds: 15 * 60, order: 3, builtin: true, work: false },
};

const EMPTY_TIMER = {
  label: null,
  durationMs: 0,
  endsAt: null,      // epoch ms; only meaningful while running
  remainingMs: null, // only meaningful while paused
  paused: false,
  running: false,
  updatedBy: null,
  updatedAt: 0,
  work: true,        // breaks don't count toward the room's worked-today total
};

export function blankState() {
  return {
    timer: { ...EMPTY_TIMER },
    presets: { ...DEFAULT_PRESETS },
    presence: {},
    sessions: {},
  };
}

// Presets arrive from the network as a plain object; normalise into a sorted
// array so render code can stay dumb.
export function presetList(presets) {
  return Object.entries(presets || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export async function createStore(roomId) {
  const configured = firebaseConfig.apiKey && firebaseConfig.databaseURL;
  if (!configured) return localStore(roomId);
  try {
    return await firebaseStore(roomId);
  } catch (err) {
    console.error("Firebase unavailable, falling back to solo mode:", err);
    const store = localStore(roomId);
    store.fallbackError = err.message || String(err);
    return store;
  }
}

/* ---------------------------------------------------------------- firebase */

async function firebaseStore(roomId) {
  const [{ initializeApp }, db] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  const database = db.getDatabase(app);
  const roomRef = db.ref(database, `rooms/${DATA_VERSION}/${roomId}`);

  // Firebase hands us the delta between this machine's clock and its own.
  // Without this, two laptops whose clocks disagree show different countdowns.
  let skew = 0;
  db.onValue(db.ref(database, ".info/serverTimeOffset"), (snap) => {
    skew = snap.val() || 0;
  });

  const stateHandlers = new Set();
  const statusHandlers = new Set();
  let state = blankState();
  let seeded = false;

  db.onValue(db.ref(database, ".info/connected"), (snap) => {
    statusHandlers.forEach((fn) => fn({ connected: snap.val() === true }));
  });

  db.onValue(
    roomRef,
    (snap) => {
      const raw = snap.val() || {};
      state = {
        timer: { ...EMPTY_TIMER, ...(raw.timer || {}) },
        presets: raw.presets || { ...DEFAULT_PRESETS },
        presence: raw.presence || {},
        sessions: raw.sessions || {},
      };
      // First client into a fresh room lays down the defaults. If both of you
      // land at once you both write the same bytes, so the race is harmless.
      if (!seeded && !raw.presets) {
        seeded = true;
        db.set(db.child(roomRef, "presets"), DEFAULT_PRESETS).catch(console.error);
      }
      seeded = true;
      stateHandlers.forEach((fn) => fn(state));
    },
    (err) => {
      statusHandlers.forEach((fn) => fn({ connected: false, error: err.message }));
    }
  );

  return {
    mode: "firebase",
    now: () => Date.now() + skew,
    getState: () => state,
    onState(fn) { stateHandlers.add(fn); fn(state); },
    onStatus(fn) { statusHandlers.add(fn); },
    setTimer(timer) {
      return db.set(db.child(roomRef, "timer"), { ...timer, updatedAt: db.serverTimestamp() })
        .catch(console.error);
    },
    setPresets(presets) {
      return db.set(db.child(roomRef, "presets"), presets).catch(console.error);
    },

    // Presence is deliberately server-managed: onDisconnect fires when the
    // socket drops, so closing the tab or losing wifi removes you without the
    // page having to do anything on the way out. beforeunload is unreliable;
    // this is not.
    announce(clientId, name) {
      const mine = db.child(roomRef, `presence/${clientId}`);
      db.onDisconnect(mine).remove();
      return db.set(mine, { name, joinedAt: db.serverTimestamp() }).catch(console.error);
    },

    logSession(key, entry) {
      return db.set(db.child(roomRef, `sessions/${key}`), entry).catch(console.error);
    },

    dropSession(key) {
      return db.set(db.child(roomRef, `sessions/${key}`), null).catch(console.error);
    },
  };
}

/* ------------------------------------------------------------------- local */

function localStore(roomId) {
  const key = `pomodoro-sync:${DATA_VERSION}:${roomId}`;
  const stateHandlers = new Set();
  const statusHandlers = new Set();

  const read = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (!raw) return blankState();
      return {
        timer: { ...EMPTY_TIMER, ...(raw.timer || {}) },
        presets: raw.presets || { ...DEFAULT_PRESETS },
        presence: raw.presence || {},
        sessions: raw.sessions || {},
      };
    } catch {
      return blankState();
    }
  };

  let state = read();
  const write = (next) => {
    state = next;
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
    stateHandlers.forEach((fn) => fn(state));
  };

  // Two tabs on the same machine still stay in step — a useful way to eyeball
  // the sync behaviour before Firebase is wired up.
  window.addEventListener("storage", (e) => {
    if (e.key !== key) return;
    state = read();
    stateHandlers.forEach((fn) => fn(state));
  });

  return {
    mode: "local",
    now: () => Date.now(),
    getState: () => state,
    onState(fn) { stateHandlers.add(fn); fn(state); },
    onStatus(fn) { statusHandlers.add(fn); fn({ connected: false }); },
    setTimer(timer) { write({ ...state, timer: { ...timer, updatedAt: Date.now() } }); },
    setPresets(presets) { write({ ...state, presets }); },

    // Solo mode has no other people in it, but carrying the same shape keeps
    // the UI code from having to special-case the backend.
    announce(clientId, name) {
      write({ ...state, presence: { [clientId]: { name, joinedAt: Date.now() } } });
    },
    logSession(key, entry) {
      write({ ...state, sessions: { ...state.sessions, [key]: entry } });
    },
    dropSession(key) {
      const next = { ...state.sessions };
      delete next[key];
      write({ ...state, sessions: next });
    },
  };
}
