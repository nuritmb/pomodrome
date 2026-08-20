# pomodoro-sync

A two-person Pomodoro timer that runs entirely on GitHub Pages. Whoever holds
the link can start, pause, reset, and edit the timer list — everyone watching
sees the same countdown.

## How it works

GitHub Pages only serves static files, so the shared state lives in a Firebase
Realtime Database that the page talks to straight from the browser.

The countdown itself is never synced. The database holds one small object:

```json
{ "label": "Focus", "durationMs": 1500000, "endsAt": 1755712800000, "paused": false }
```

Each browser computes `endsAt - now` and renders its own tick, so a write only
happens when somebody presses a button — a handful per hour, nowhere near the
free tier. Clock skew between the two machines is corrected using Firebase's
`.info/serverTimeOffset`, so you both see the same number of seconds left even
if one laptop's clock is off.

**The room id in the URL hash is the key.** Anyone with the link can control the
timer; anyone without it cannot guess the room. Send the link to your friend and
bookmark it.

## Setup

1. Create a project at <https://console.firebase.google.com> (no billing needed).
2. **Build → Realtime Database → Create Database.** Pick a region, start in
   locked mode.
3. **Project settings → General**, scroll to the bottom. A fresh project has no
   apps yet, so "Your apps" reads *"There are no apps in your project"* — click
   the **`</>`** (web) icon to create one. Any nickname will do; leave "Also set
   up Firebase Hosting" unchecked, since GitHub Pages is the host. **Register
   app** then shows the config snippet — copy those values into `config.js`.

   Make sure `databaseURL` is among them; it is omitted unless the database
   already exists, which is why step 2 comes first. If it is missing, the Data
   tab of the Realtime Database shows it at the top, in the form
   `https://<project-id>-default-rtdb.firebaseio.com` (or
   `...-default-rtdb.<region>.firebasedatabase.app` outside the US).

   To see the snippet again later: **Project settings → General → Your apps →
   SDK setup and configuration → Config**.
4. Paste the rules below into **Realtime Database → Rules → Publish**.
5. Push to GitHub, then **Settings → Pages → Deploy from branch → main / root**.
6. Open the page, click **Copy invite link**, send it to your friend.

Until `config.js` is filled in the app runs in solo mode against `localStorage`
— fully usable on one machine, and two tabs stay in step, which is a decent way
to see the sync behaviour before Firebase exists.

## Database rules

These allow unauthenticated access, but only to a room whose id is at least 20
characters — an unguessable path — and only to data of the right shape, so a
stray write cannot fill your database.

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "v1": {
        "$room": {
          ".read": "$room.length >= 20",
          ".write": "$room.length >= 20",
          "timer": {
            "label":       { ".validate": "newData.isString() && newData.val().length <= 24" },
            "durationMs":  { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 36000000" },
            "endsAt":      { ".validate": "newData.isNumber()" },
            "remainingMs": { ".validate": "newData.isNumber()" },
            "paused":      { ".validate": "newData.isBoolean()" },
            "running":     { ".validate": "newData.isBoolean()" },
            "updatedBy":   { ".validate": "newData.isString() && newData.val().length <= 32" },
            "updatedAt":   { ".validate": "newData.isNumber()" },
            "$other":      { ".validate": false }
          },
          "presets": {
            "$preset": {
              "name":    { ".validate": "newData.isString() && newData.val().length <= 24" },
              "seconds": { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 36000" },
              "order":   { ".validate": "newData.isNumber()" },
              "builtin": { ".validate": "newData.isBoolean()" },
              "$other":  { ".validate": false }
            }
          },
          "$other": { ".validate": false }
        }
      }
    }
  }
}
```

The values in `config.js` are public identifiers, not secrets — it is expected
that they sit in a public repo. The rules above are what actually protect the
data.

## Notes

- Space toggles start/pause, `R` resets.
- Timers you add are shared: your friend sees them appear, and either of you can
  remove them.
- The end-of-timer chime needs the tab to have been clicked at least once, since
  browsers block audio on pages the user has not interacted with.
