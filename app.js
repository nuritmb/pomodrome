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
  track: document.getElementById("track"),
  fill: document.getElementById("fill"),
  add: document.getElementById("add"),
  addName: document.getElementById("add-name"),
  addMins: document.getElementById("add-mins"),
  modeNote: document.getElementById("mode-note"),
};

/* ------------------------------------------------------------------- wash */
// The page background creeps from --wash-start to --wash-end as the timer runs,
// so elapsed time is legible from across the room without reading the digits.
// The colours live in CSS as "r g b" triples so the theme owns them and this
// only does the arithmetic.

const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Read on every paint rather than cached. Caching meant a theme switch left the
// old palette in place — and getComputedStyle four times a second costs nothing
// next to being wrong.
function washColors() {
  const cs = getComputedStyle(document.documentElement);
  const parse = (name) => cs.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
  const usable = (c) => c.length === 3 && c.every(Number.isFinite);
  const start = parse("--wash-start");
  const end = parse("--wash-end");
  return usable(start) && usable(end) ? [start, end] : null;
}

function paintWash(progress) {
  const colors = washColors();
  if (!colors) return;   // stylesheet not in yet; the next paint will catch it
  const [from, to] = colors;
  const mix = from.map((c, i) => Math.round(c + (to[i] - c) * progress));
  document.body.style.backgroundColor = `rgb(${mix.join(" ")})`;
}

/* ------------------------------------------------------------------ chime */
// The chime is scheduled the moment a run starts, not when render() notices the
// clock hit zero. A hidden tab has its timers throttled to roughly once a
// minute, so anything driven by the render loop rings late — but the audio
// clock runs on its own thread and is not throttled, so a tone handed to it
// with a start time will sound on the second regardless of what the tab is
// doing. Pausing or resetting cancels the pending tone; the next start
// schedules a fresh one.

let audio;
let scheduled = [];      // oscillators handed to the audio clock, not yet played
let scheduledFor = null; // the endsAt they were scheduled against

// Browsers block audio until the page has been interacted with, so unlock the
// context on the first click this tab sees.
addEventListener("pointerdown", () => {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === "suspended") audio.resume();
}, { once: true });

function cancelChime() {
  for (const osc of scheduled) {
    try { osc.stop(); } catch { /* already played out */ }
  }
  scheduled = [];
  scheduledFor = null;
}

function scheduleChime(msFromNow, endsAt) {
  cancelChime();
  // No audio context until the tab has been clicked once; render() keeps
  // calling, so this picks itself up as soon as the user interacts.
  if (!audio || audio.state !== "running") return;

  const at0 = audio.currentTime + Math.max(0, msFromNow) / 1000;
  [0, 0.24, 0.48].forEach((offset, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = at0 + offset;
    osc.frequency.value = 660 + i * 110;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.22);
    scheduled.push(osc);
  });
  scheduledFor = endsAt;
}

// Called every render: keeps the pending tone in step with the shared state,
// including a run your friend started, since state updates arrive over the
// network rather than on a throttled timer.
function syncChime(timer, now, done) {
  if (done) return;  // already ringing or rung — leave it alone to play out
  if (timer.running && !timer.paused) {
    if (scheduledFor !== timer.endsAt) scheduleChime(timer.endsAt - now, timer.endsAt);
  } else if (scheduledFor !== null) {
    cancelChime();
  }
}

/* ------------------------------------------------------------------ state */
const store = await createStore(roomId);
let state = store.getState();

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

  document.title = armed && t.running && !t.paused && !done ? `${fmt(rem)} · ${t.label}` : "Pomodrome";

  // How far through the current run we are, which drives the background wash.
  // Idle sits at 0, a finished timer holds at 1, and pausing simply freezes it
  // because remainingMs stops moving.
  const progress = !armed ? 0 : done ? 1 : clamp01(1 - rem / t.durationMs);
  paintWash(progress);

  // The bar drains as the run proceeds: full at the start, empty at zero.
  const left = Math.round((1 - progress) * 100);
  el.track.dataset.idle = String(!armed);
  el.fill.style.width = `${left}%`;
  el.track.setAttribute("aria-valuenow", String(left));

  syncChime(t, now, done);
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

/* ------------------------------------------------------------------- loop */
renderPresets();
render();
setInterval(render, 250);
