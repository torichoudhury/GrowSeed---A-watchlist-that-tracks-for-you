# Deploying to Vercel (replay demo)

What this ships: the **4 September 2026 replay** — the seeded 20-stock demo
watchlist, real prices from that session, served against a shifted clock. Live
WebSocket ticks are **off** by design (see "Why there are no live ticks").

The data already lives in Supabase, so there is nothing to seed at deploy time —
but the seeded dataset, the `DEMO_AS_OF` value and `DEMO_BASELINE_AT` must move
together (re-run `npm run demo:seed` locally to refresh all three).

---

## 1. What is in the repo

| File | Purpose |
|---|---|
| `vercel.json` | Two services — `frontend` (Next.js, built natively) and `backend` (Express, built as a container). `/api/*` and `/health` route to the backend, everything else to the frontend. |
| `backend/Dockerfile.vercel` | Multi-stage build: compile TypeScript, then ship production dependencies plus `dist/` only. Listens on port 80, which is the port Vercel routes to by default. |
| `backend/.dockerignore` | Keeps `.env`, tests and `node_modules` out of the image. |

Both services share one deployment and one domain, so the browser calls
`/api/...` on its own origin and Vercel proxies it to the backend. No CORS
preflight, no second domain.

> The config you started from had `"destination": {"type": "service", ...}`.
> Vercel's schema is `{"service": "backend"}` with no `type` key, and
> `/api/backend/(.*)` would have made the real paths `/api/backend/api/auth/login`.
> Since the frontend has no `/api` routes of its own, `/api/(.*)` goes to the
> backend wholesale.

## 2. Environment variables to set in the Vercel dashboard

Values are in your local `backend/.env` — **do not commit it**, it is
gitignored for a reason.

**Required (backend):**

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** URI (port `6543`), not the direct `5432` one | Each instance opens its own pool; the direct connection limit is reached quickly |
| `PG_POOL_MAX` | `3` | The ceiling is instances × pool size |
| `REDIS_URL` | your Upstash `rediss://` URI | Quote cache and single-flight |
| `JWT_SECRET` | the same value as local | The process refuses to start without it, by design |
| `DEMO_AS_OF` | `2026-09-04` | The session being replayed (must be AFTER the baseline below) |
| `DEMO_SPEED` | `6` | Six demo seconds per real second — a full session in ~62 real minutes |
| `DEMO_LABEL` | `on` | Shows the "Replay" badge, so nobody mistakes it for a live market |
| `DEMO_AUTO_ACK` | `off` | Keeps the "since you last checked" story on screen instead of clearing it after 3s |
| `DEMO_BASELINE_AT` | `2026-07-20T10:00:00+05:30` | "You last checked" Monday 20 Jul 2026, 10:00 IST — the demo's fixed baseline (chosen for real ≥5% movers into 04 Sep) |

**Do not set** `PORT` (the container and Vercel both default to 80), and **do
not set** `MARKET_DATA_PROVIDER` (unused in replay mode). `GROWW_API_KEY` /
`GROWW_API_SECRET` are not needed either — nothing calls Groww while replaying.

**Frontend: leave `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` UNSET.**
That is what makes the browser call its own origin. Setting them to the
localhost values from `frontend/.env.local` would point every visitor's browser
at their own machine. (`.env.local` is gitignored, so it will not reach Vercel
on its own.)

`DEMO_LOOP` defaults to `on` whenever `VERCEL` is set — no need to configure it.

## 3. Deploy

Import the repository in the Vercel dashboard, set the variables above, and
deploy. The first build compiles the container image, so it is slower than a
normal Next.js build.

Afterwards, check `https://<your-domain>/health` — it reports the clock mode,
pool counts, Redis state and every circuit breaker:

```json
{ "status": "ok", "clock": { "mode": "replay", "asOf": "2026-09-04", "now": "..." }, ... }
```

Log in with the demo credentials and open **Demo Watchlist**.

## 4. Why there are no live ticks

Vercel scales a container to zero after five minutes without traffic. The
30-second `market-refresh` loop is `node-cron` **inside the process** — it is
what fetches quotes and publishes the WebSocket ticks — so with no process
there are no ticks, and a socket that connects but never delivers would show
"Live" over prices that actually came from the client's 30-second poll.

So on Vercel:

- `startJobs()` returns immediately when `VERCEL` is set. All seven jobs are
  off, which is safe here because replay mode never writes anyway.
- The frontend does not open a socket (no `NEXT_PUBLIC_WS_URL`), and the header
  honestly reads **Polling**. Prices still advance, because the replay clock
  moves and each poll reads the next 5-minute bar.

The replay clock is **stateless on Vercel**: it is derived from the wall clock
rather than from process start, so a cold start cannot rewind the session, and
every instance agrees on where the replay is. It loops back to the open when it
reaches the close.

If you later want the real thing — 30-second ticks, a live socket, and the
nightly statistics and corporate-action jobs — the backend needs a host that
does not sleep (Railway, Render, Fly, Cloud Run). Nothing in the code changes:
point `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` at it and drop the
`backend` service from `vercel.json`.

## 5. Known limits of this deployment

- **Cold starts.** The first request after five idle minutes pays the container
  start plus a fresh Supabase and Upstash connection — a few seconds. Warm
  requests are ~1s for a 20-stock summary.
- **Statistics go stale** if you ever switch this deployment to live data: the
  recalculation, candle rollup and fundamentals jobs do not run here.
- **The session loops.** After ~62 real minutes the replay wraps from the close
  back to the open, so prices jump once per cycle.
- **In-process state is per-instance**: circuit breakers, the provider
  concurrency gate and the replay bar cache are not shared between instances.
  All of them degrade safely.
