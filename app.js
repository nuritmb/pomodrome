import { createStore, presetList } from "./sync.js";

/* ---------------------------------------------------------------- room id */
// The room id lives in the URL hash, so the link *is* the shared key: send it
// to your friend and you are both in the same room. No accounts, no login.
function getRoomId() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("room");
  if (fromHash && /^[a-z0-9]{8,48}$/i.test(fromHash)) return fromHash;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const id = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
  history.replaceState(null, "", `#room=${id}`);
  return id;
}

const roomId = getRoomId();

// Stable per-browser id, only ever used to tell "you" from "your friend".
const me = (() => {
  const k = "pomodoro-sync:client";
  let v = localStorage.getItem(k);
  if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
  return v;
})();

/* ------------------------------------------------------------------- dom */
const el = {
  status: document.getElementById("status"),
  invite: document.getElementById("invite"),
  label: document.getElementById("label"),
  clock: document.getElementById("clock"),
  note: document.getElementById("note"),
  toggle: document.getElementById("toggle"),
  reset: document.getElementById("reset"),
  chips: document.getElementById("chips"),
  add: document.getElementById("add"),
  addName: document.getElementById("add-name"),
  addMins: document.getElementById("add-mins"),
  modeNote: document.getElementById("mode-note"),
};

/* ------------------------------------------------------------------ state */
const store = await createStore(roomId);
let state = store.getState();
let chimedFor = null;

store.onState((next) => { state = next; renderPresets(); render(); });
store.onStatus(setStatus);

if (store.mode === "local") {
  setStatus({ connected: false });
  el.modeNote.textContent = store.fallbackError
    ? `Solo mode — could not reach Firebase (${store.fallbackError}).`
    : "Solo mode — add your Firebase config in config.js to share this timer.";
} else {
  el.modeNote.textContent = "Anyone with this link can control the timer.";
}

function setStatus({ connected, error }) {
  if (store.mode === "local") {
    el.status.dataset.state = "solo";
    el.status.textContent = "solo";
    return;
  }
  if (error) {
    el.status.dataset.state = "error";
    el.status.textContent = "error";
    // "Permission denied" almost always means the database rules were never
    // published, which is otherwise invisible from the page.
    el.modeNote.textContent = /permission/i.test(error)
      ? "Database refused the connection — publish the rules from README.md."
      : `Database error: ${error}`;
    return;
  }
  el.status.dataset.state = connected ? "live" : "offline";
  el.status.textContent = connected ? "live" : "offline";
  el.modeNote.textContent = "Anyone with this link can control the timer.";
}

/* ------------------------------------------------------- timer arithmetic */
// Nothing about the countdown is synced — only the endsAt timestamp is. Each
// browser derives its own display from that, so there is no per-second traffic.
function remainingMs(timer, now) {
  if (!timer.durationMs) return null;
  if (timer.running && !timer.paused) return timer.endsAt - now;
  if (timer.paused) return timer.remainingMs ?? 0;
  return timer.durationMs;
}

// Declared as a function, not a const arrow: render() runs the moment the
// store hands over its first snapshot, which is above this line.
function isFinished(timer, now) {
  return timer.running && !timer.paused && timer.endsAt <= now;
}

function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ----------------------------------------------------------------- render */
function render() {
  const now = store.now();
  const t = state.timer;
  const rem = remainingMs(t, now);
  const done = isFinished(t, now);
  const armed = Boolean(t.durationMs);

  el.label.textContent = t.label || "Pick a timer";
  el.clock.textContent = rem === null ? "--:--" : fmt(done ? 0 : rem);
  el.clock.classList.toggle("done", done);

  el.toggle.disabled = !armed;
  el.reset.disabled = !armed || (!t.running && !t.paused);
  el.toggle.textContent = done ? "Restart"
    : t.paused ? "Resume"
    : t.running ? "Pause"
    : "Start";

  if (done) {
    el.note.textContent = "Time's up.";
  } else if (t.running && t.updatedBy) {
    el.note.textContent = `${t.paused ? "Paused" : "Started"} by ${t.updatedBy === me ? "you" : "your friend"}`;
  } else {
    el.note.innerHTML = "&nbsp;";
  }

  document.title = armed && t.running && !t.paused && !done ? `${fmt(rem)} · ${t.label}` : "Pomodoro";

  // Chime once per completed run. endsAt is a fresh millisecond value on every
  // start, so remembering the last one chimed for is enough to avoid repeats.
  if (done && chimedFor !== t.endsAt) { chimedFor = t.endsAt; chime(); }
}

function renderPresets() {
  const current = state.timer.label;
  el.chips.replaceChildren(...presetList(state.presets).map((p) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("aria-pressed", String(p.name === current));
    chip.addEventListener("click", () => selectPreset(p));

    const name = document.createElement("span");
    name.textContent = p.name;
    const mins = document.createElement("span");
    mins.className = "mins";
    mins.textContent = `${Math.round(p.seconds / 60)}m`;
    chip.append(name, mins);

    if (!p.builtin) {
      const kill = document.createElement("span");
      kill.className = "kill";
      kill.setAttribute("role", "button");
      kill.title = `Remove ${p.name}`;
      kill.textContent = "×";
      kill.addEventListener("click", (e) => { e.stopPropagation(); removePreset(p); });
      chip.append(kill);
    }
    return chip;
  }));
}

/* ---------------------------------------------------------------- actions */
// Selecting is shared too, so you are never looking at different timers.
function selectPreset(p) {
  const ms = p.seconds * 1000;
  store.setTimer({
    label: p.name, durationMs: ms, endsAt: null, remainingMs: ms,
    paused: false, running: false, updatedBy: me,
  });
}

function toggle() {
  const now = store.now();
  const t = state.timer;
  if (!t.durationMs) return;

  if (isFinished(t, now) || !t.running) {
    const from = isFinished(t, now) ? t.durationMs : (remainingMs(t, now) || t.durationMs);
    store.setTimer({ ...t, endsAt: now + from, remainingMs: null, running: true, paused: false, updatedBy: me });
  } else if (t.paused) {
    store.setTimer({ ...t, endsAt: now + (t.remainingMs ?? t.durationMs), remainingMs: null, paused: false, updatedBy: me });
  } else {
    store.setTimer({ ...t, remainingMs: Math.max(0, t.endsAt - now), endsAt: null, paused: true, updatedBy: me });
  }
}

function reset() {
  const t = state.timer;
  store.setTimer({ ...t, endsAt: null, remainingMs: t.durationMs, running: false, paused: false, updatedBy: me });
}

function removePreset(p) {
  if (!confirm(`Remove "${p.name}" for both of you?`)) return;
  const next = { ...state.presets };
  delete next[p.id];
  store.setPresets(next);
}

el.add.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = el.addName.value.trim();
  const mins = Number(el.addMins.value);
  if (!name || !Number.isFinite(mins) || mins < 1 || mins > 600) return;

  const orders = presetList(state.presets).map((p) => p.order ?? 0);
  const id = `c${Math.random().toString(36).slice(2, 10)}`;
  store.setPresets({
    ...state.presets,
    [id]: { name, seconds: Math.round(mins * 60), order: Math.max(0, ...orders) + 1, builtin: false },
  });
  el.add.reset();
  el.addName.focus();
});

el.toggle.addEventListener("click", toggle);
el.reset.addEventListener("click", reset);

el.invite.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    el.invite.textContent = "Copied!";
  } catch {
    prompt("Copy this link:", location.href);
    el.invite.textContent = "Copy invite link";
    return;
  }
  setTimeout(() => { el.invite.textContent = "Copy invite link"; }, 1600);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // A focused control already handles Space itself, and typing in the "add
  // timer" fields must not drive the clock.
  if (e.target.closest?.("input, button")) return;
  if (e.code === "Space") { e.preventDefault(); toggle(); }
  if (e.key.toLowerCase() === "r") reset();
});

/* ------------------------------------------------------------------ chime */
let audio;
// Browsers block audio until the page has been interacted with, so unlock the
// context on the first click this tab sees.
addEventListener("pointerdown", () => {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === "suspended") audio.resume();
}, { once: true });

function chime() {
  if (!audio) return;
  [0, 0.24, 0.48].forEach((offset, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = audio.currentTime + offset;
    osc.frequency.value = 660 + i * 110;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.22);
  });
}

/* ------------------------------------------------------------------- loop */
renderPresets();
render();
setInterval(render, 250);
