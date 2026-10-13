# Volley

Private two-player turn-based games. Single `index.html` PWA on Vercel, Supabase (Loop's project, `volley_` tables).

## Files
- `index.html` — the whole app (CSS + JS inline). Checkers engine lives in the `CK` object.
- `sw.js` — service worker for push notifications and the app badge.
- `api/db.js` — passcode-gated data endpoint (`POST { action }`).
- `api/push.js` — saves push subscriptions, sends a test push.
- `api/cron.js` — turn-timer sweep (warnings + forfeits). Called by Supabase every 15 min and by Vercel daily.
- `api/_lib/core.js` — shared helpers (not an endpoint).
- `vercel.json` — cache headers + daily backup cron.
- `package.json` — `web-push` dependency (Vercel installs it automatically).

## Env vars
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VOLLEY_PASSCODE`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`.
Env var changes need a manual Redeploy.
