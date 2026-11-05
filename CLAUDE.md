# Harmony Booth

A static single-page app ("Harmony Booth") that records a short lead vocal in the browser,
generates two harmony voices offline via `Tone.PitchShift` (fixed intervals: +major 3rd,
+perfect 5th — not key-aware, just a quick fun stack), lets you mix/mute/solo/preview the
three voices live, and export/share a WAV of the current mix. No build step, no backend —
`index.html` + `app.js` + `style.css`.

## Architecture
- `VOICES` in `app.js`: lead (0 semitones), Harmony 2 (+4), Harmony 3 (+7).
- Record → offline-render harmonies with Tone.js → live mixer (mute/solo/volume per voice,
  play/pause/stop/loop, progress bar) → export current mix as WAV → Web Share API.

## Known issues & fixes (already applied — don't reintroduce)
- **iOS Safari can silently kill/reload the tab under memory pressure**, especially after
  a longer recording — this looks exactly like an unexplained page refresh and throws no
  catchable JS error, so an in-memory log is useless (the process holding it is gone).
  Fix: every step is persisted to `sessionStorage` (`DIAG_KEY = 'hb_diag_log_v1'`) as it
  happens. On next load, if a log exists and wasn't marked `complete`, it's shown as
  "Log from a session that didn't finish cleanly last time" in the Diagnostics panel
  (auto-expanded via `has-crash-log` / `diagBody.hidden = false` so the user doesn't have to
  hunt for it). **Do not replace this with a plain in-memory array** — that's the exact bug
  this was built to work around.
- Recordings longer than 90s log a console warning (`app.js` ~line 303) that harmony
  rendering may be slow/memory-heavy on mobile — this is a known soft limit, not enforced,
  just flagged. If mobile crashes resurface, check whether they correlate with long
  recordings before assuming a new bug.
