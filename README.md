# Smart Market Watchlist

A market watchlist that tells you **what meaningfully changed since you last looked, and why it matters** — not just prices and raw percentages.

- Dependency & System Requirements: [`requirement.txt`](./requirement.txt)

---

## The Logic of Meaningful Change

Most financial watchlists are noisy firehoses: they sort stocks by raw percentage change and flood the screen with green and red ticks. A 2% move on a high-beta stock during a 2% index rally is completely ordinary, while a 2% drop on an FMCG defensive stock during a flat session is a major idiosyncratic development. Similarly, an unrecorded 1:1 stock bonus can appear as a catastrophic 50% crash, while a stock quietly consolidating on massive institutional accumulation goes unnoticed.

**Smart Market Watchlist** replaces naive price tracking with a **calibrated, multi-lens intelligence engine**. It answers three questions whenever you open the app:
1. **Is this move unusual for *this specific stock*?** (Time-Series Lens)
2. **Is this the stock's own story, or just the market/sector tide?** (External Context Lens)
3. **Was there an underlying corporate event, result, or filing that caused it?** (Internal Fundamentals Lens)

The result is a unified **0–100 Attention Score** mapped to rigorous severity bands (**QUIET**, **LOW**, **MEDIUM**, **HIGH**, **CRITICAL**) that reflect verified historical base rates.

```
+------------------------------------------------------------------------------------------------------+
|                              THE ATTENTION SCORE FORMULA                                             |
|                                                                                                      |
|  Score = [ Time-Series (50) + External (25) + Fundamentals (20) + User Alerts (5) ]                 |
|          x Correlation Discount        (0.85 - 0.93)                                                 |
|          x Volatility Regime Dampener  (0.60 - 1.00)                                                 |
|          x Watchlist Breadth Dampener  (0.80 - 1.00)                                                 |
|          x Freshness Penalty           (0.00 - 1.00)                                                 |
|          --> Piecewise-Linear Base-Rate Calibration --> Final Score (0-100)                           |
+------------------------------------------------------------------------------------------------------+
```

---

### 1. The Four Scoring Pillars (100-Point Budget)

| Component | Max Points | Question It Answers | Key Statistics & Signals |
|---|:---:|---|---|
| **Time-Series** | **50** | How unusual is today vs. this stock's own history? | Empirical return percentiles ($p_{90}, p_{95}, p_{98}, p_{99}, \text{max}$); robust MAD z-scores; price-volume confirmation; open gap; signed streaks; milestone crossings; two-window level shifts. |
| **External Context** | **25** | Is this stock-specific news or broader market/sector drift? | Rolling 90-day market model ($r_s = \alpha + \beta \cdot r_{\text{NIFTY}}$) beta-adjusted residuals; sector index divergence; market volatility regime & India VIX dampening; watchlist breadth. |
| **Company Fundamentals** | **20** | Was something scheduled, reported, or announced? | NSE corporate actions (splits, bonuses, dividends); board meeting results calendar (upcoming & recent); corporate filings & announcements. |
| **User Intent** | **5** | Did the user explicitly ask to track this? | Price target and floor alerts with 0.50% hysteresis deadbands. |

---

### 2. Deep Dive: Mathematical & Algorithmic Foundations

#### A. Empirical Percentiles vs. Gaussian Z-Scores (Fat Tails)
Financial asset returns are leptokurtic (fat-tailed). Under a standard normal distribution, a move with $|z| \ge 2.5$ would theoretically happen once every 160 trading days; in Indian equity markets, fat tails make this occur far more frequently. Furthermore, a ₹10 penny stock exhibits a fundamentally different variance profile than a ₹5,000 blue-chip.

Instead of assuming Gaussian returns, the engine tracks the **empirical distribution of absolute returns** over the trailing 250 trading days:
- **$p_{90}$**: Top 10% move of the year $\rightarrow$ earns 40% of the price category cap.
- **$p_{95}$**: Top 5% move $\rightarrow$ earns 60% of the cap.
- **$p_{98}$**: Top 2% move $\rightarrow$ earns 80% of the cap.
- **$p_{99}$ / $\text{MAX}$**: Top 1% or largest move of the year $\rightarrow$ earns 90% to 100% of the cap.

This makes every threshold **distribution-free, self-normalizing, and intuitively explainable**: *"Bigger than 99% of its daily moves this year"* is a verifiable statement the user can trust.

#### B. Robust Estimators: Median & MAD
Standard mean and standard deviation are heavily skewed by single-day outliers (such as earnings surprises or market crashes). The engine relies on robust location and scale estimators:
$$\text{Modified } Z = \frac{0.6745 \cdot (X - \text{Median}(X))}{\max(1, \text{MAD}(X))}$$
Where $\text{MAD}(X) = \text{Median}(|X - \text{Median}(X)|)$. This is applied to:
- **Volume**: Detecting abnormal volume without letting one blowout day distort the baseline.
- **Price Volatility**: Evaluating today's price range against typical 30-day dispersion.

#### C. Beta-Adjusted Residuals (Market & Sector Neutrality)
A high-beta stock ($\beta = 1.4$) dropping 2.8% on a day the Nifty 50 drops 2.0% is performing exactly as expected. A low-beta defensive stock ($\beta = 0.7$) dropping 2.8% on a flat day is experiencing serious idiosyncratic selling pressure.

The engine computes a rolling 90-day ordinary least-squares market model:
$$r_{s,t} = \alpha + \beta \cdot r_{\text{NIFTY},t} + \epsilon_{s,t}$$
The **residual** $\epsilon_s = r_s - (\alpha + \beta \cdot r_{\text{NIFTY}})$ represents the true stock-specific component. The engine computes the modified z-score of this residual against the stock's historical residual MAD:
$$\text{Residual } Z = \frac{0.6745 \cdot \epsilon_s}{\text{MAD}(\epsilon)}$$
The same technique is applied against the stock's **NSE sector index** (e.g., Nifty Bank, Nifty Auto, Nifty IT) to determine whether the movement is sector-driven or unique to the company.

#### D. Dynamic Macro Regime & Breadth Dampeners
When the overall market enters a high-volatility panic or major trending day, individual stock moves become naturally noisier. Rather than falsely elevating every stock to CRITICAL, the engine dampens individual attention scores:
1. **Realized Volatility Ratio**: Computes the benchmark's 20-day realized volatility over its 250-day norm ($vol_{20d} / vol_{250d}$). If the ratio exceeds $1.3\times$, a smooth dampener scales down raw scores (up to a $0.60\times$ floor).
2. **India VIX Percentile**: If India VIX crosses its 90th percentile over the trailing year, a further $0.90\times$ multiplier is applied.
3. **Watchlist Breadth**: If $\ge 70\%$ of the watchlist moves in the same direction, individual moves are recognized as a macro wave and dampened by $0.80\times$.

#### E. Multi-Horizon Cadence Adaptation (`DAY`, `WEEK`, `MONTH`, `AUTO`)
"Meaningful change" is intrinsically tied to **how often the user checks their portfolio**:
- To a **daily checker**, a 2.5% move is major news.
- To a **monthly checker**, a 2.5% move is unremarkable noise within a 20-session window.

The summary endpoint dynamically adapts via `?horizon=AUTO|DAY|WEEK|MONTH`:
- In `AUTO` mode, the horizon is inferred from the user's actual absence ($<4$ days $\rightarrow$ `DAY`, $4\text{--}11$ days $\rightarrow$ `WEEK`, $\ge 12$ days $\rightarrow$ `MONTH`).
- When switching to `WEEK` (5 sessions) or `MONTH` (20 sessions), the move is evaluated against the empirical distribution of **its own multi-session returns** ($p_{90}$, $p_{95}$, $p_{98}$ of rolling 5-day / 20-day windows over the trailing year).
- The baseline noise floor scales by $\sqrt{\text{sessions}}$ (the random-walk square-root-of-time scaling).

#### F. Signal Synthesis & Correlation Discounting
Price move, abnormal volume, and intraday volatility often fire simultaneously from a single news shock. Summing them directly would result in artificial double- or triple-counting.
- If all 3 time-series signals fire together: discounted by **$0.85\times$**.
- If 2 time-series signals fire together: discounted by **$0.93\times$**.
- Price milestones (52w high/low, 30d high/low, streaks, drawdown) take the **maximum** milestone score rather than accumulating.
- Level-shift tests compare 5-day vs. 30-day mean returns using $t = \frac{m_5 - m_{30}}{\sigma_{90} / \sqrt{6}}$, accounting for the statistical covariance of overlapping windows.

#### G. The Statistical Corporate-Action Guard
A stock split (e.g., 2:1) or bonus issue (e.g., 1:1) cuts the quoted stock price overnight by 50%. If an announcement is missing from the exchange calendar, a naive algorithm would sound a CRITICAL alert ("Down 50%!") and pollute the stock's historical volatility distribution for the next 12 months.

The engine features a dedicated 4-point statistical guard (`services/fundamentals/splitDetector.ts`):
1. **Clean Ratio**: The overnight factor lands within $\pm 0.4\%$ of an exact corporate ratio ($\frac{1}{2}, \frac{1}{3}, \frac{2}{5}, \frac{1}{10}, \dots$).
2. **Move Magnitude**: The overnight change is $\ge 15\%$ (NSE price bands make genuine one-day moves of this magnitude exceedingly rare).
3. **Price Range Clearance**: The entire trading session remains strictly clear of the pre-event price level (a market crash dips and fluctuates back; a structural re-scaling never trades back through the old price).
4. **Next-Session Stability**: The following session returns to normal volatility ($<5\%$).

**Action Taken**: When flagged, all price, volume, and relative signals are immediately zeroed (`breakdown.mechanical: true`). The move is explained to the user as a mechanical re-scaling rather than news, and recorded in `SUSPECTED_ADJUSTMENT` for audit.

---

### 3. Base-Rate Calibration & Severity Bands

Uncalibrated scoring models suffer from "score compression" due to multiplicative dampeners, causing high severity bands to never trigger in practice. 

The attention engine is calibrated via a monotone piecewise-linear mapping anchored to empirical quantiles over **5,451 NSE stock-days** (23 stocks across 243 trading sessions):

| Severity Band | Score Range | Target Base Rate | Realized Base Rate | Real-World Meaning |
|---|:---:|:---:|:---:|---|
| **CRITICAL** | **81-100** | 1.5% | **1.54%** | Rare, major catalyst (earnings shock, unexpected CEO resignation, extreme breakout). On a 10-stock watchlist, occurs roughly once per week. |
| **HIGH** | **61-80** | 6.0% | **6.40%** | Significant divergence from market/sector, earnings season volatility, or breaking technical milestone. |
| **MEDIUM** | **41-60** | 15.0% | **16.29%** | Notable move above historical $p_{90}/p_{95}$, moderate volume buildup, or upcoming earnings date. |
| **LOW** | **21-40** | 35.0% | **36.62%** | Mild drift beyond normal noise floor; routine market movement. |
| **QUIET** | **0-20** | 42.5% | **39.15%** | Market noise; stock is behaving entirely within its historical expectations. |

To regenerate or verify calibration anchors against active database history:
```bash
cd backend && npm run calibrate
```

---

### 4. How Meaningful Change Appears in the Product

```
+------------------------------------------------------------------------------------------------------+
|  WATCHLIST SUMMARY DIGEST                                                                            |
|  "Tata Motors dropped 4.73% after quarterly results; broad market calm with India VIX at 13.2"      |
+------------------------------------------------------------------------------------------------------+
|  FACTORS PANEL (Macro vs. Micro)                                                                     |
|  External Forces (Market)                   Internal Catalysts (Selected Stock)                      |
|  * NIFTY 50 -0.18% (neutral tailwind)       * Results reported 2 days ago                           |
|  * Volatility calm (1.04x)                  * -3.42% idiosyncratic drop beyond Nifty beta           |
|  * Breadth: 12 up / 8 down                  * Volume 2.4x 30-day average                            |
+------------------------------------------------------------------------------------------------------+
|  MARKET INDICATORS PANEL                                                                             |
|  [Benchmark: Neutral]  [Breadth: Positive]  [Volatility Regime: Calm]  [India VIX: Normal]          |
+------------------------------------------------------------------------------------------------------+
```

1. **Watchlist Digest**: A single, human-readable sentence at the top of the screen synthesizing the session's most critical event, plus up to three highlighted mover bullets.
2. **Prioritized Explanations**: Each stock row presents up to 4 deterministic explanation bullets in order of structural importance:
   - Data / corporate action alerts (e.g. *"Stock split effective today — history re-based"*).
   - User alert triggers (e.g. *"Hit your price target of ₹1,450.00"*).
   - Fundamental events (e.g. *"Results announced yesterday"*).
   - Statistical rarity (e.g. *"Bigger than 99% of its single-day moves this year (-4.73%)"*).
   - Beta-adjusted attribution (e.g. *"Stock-specific: 3.10% down beyond what its usual sensitivity to Nifty explains"*).
3. **Movement Conclusion**: High-level verdict classifying the driver into:
   - `Mostly stock-specific`
   - `Mostly sector-driven`
   - `Mostly market-driven`
   - `Corporate action affects price interpretation`
   - `Mixed drivers`

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Backend** | Node 24 / TypeScript / Express 5 | API services, statistical calculation engine, WebSocket server |
| **Frontend** | Next.js 16 / React 19 / TanStack Query 5 / Tailwind 4 | Responsive UI, real-time cache synchronization, TradingView charts |
| **Database** | PostgreSQL 15+ (Supabase / local) | Relational store for instruments, candles, statistics, users, watchlists |
| **Caching & PubSub** | Redis 7+ (Upstash / local) | Sub-second quote caching, WebSocket pub/sub fanout, rate-limit state |
| **Market Data Providers** | Yahoo Finance (free, default) / Groww Trade API | Daily and intraday candles, real-time quotes |
| **Fundamentals & Sectors** | NSE India Corporate Actions & Results Calendars | Ex-dates, dividends, results dates, Nifty 500 sector mappings |

---

## Project Structure

```
GrowSeed---A-watchlist-that-tracks-for-you/
|
|-- backend/                         # Node.js / TypeScript API server
|   |-- src/
|   |   |-- index.ts                 # Entry point: Express app, WebSocket, cron bootstrap
|   |   |-- jobs/
|   |   |   `-- cron.ts              # Background worker scheduler (node-cron)
|   |   |-- config/
|   |   |   |-- db.ts                # Postgres pool, keepalives, withTransaction
|   |   |   |-- redis.ts             # Redis client
|   |   |   |-- thresholds.ts        # Shared numeric constants (TTL, concurrency, etc.)
|   |   |   `-- calibration.ts       # Scoring calibration anchors
|   |   |-- middleware/
|   |   |   `-- auth.ts              # JWT authentication middleware
|   |   |-- models/
|   |   |   `-- quote.ts             # NormalizedQuote type
|   |   |-- routes/
|   |   |   |-- auth.ts              # POST /api/auth/register|login
|   |   |   |-- watchlists.ts        # GET|POST|DELETE /api/watchlists/*
|   |   |   |-- market.ts            # GET /api/market/quotes|history
|   |   |   |-- instruments.ts       # GET /api/instruments/search
|   |   |   |-- stocks.ts            # GET /api/stocks/:id/intelligence|chart
|   |   |   |-- explore.ts           # GET /api/explore
|   |   |   `-- demo.ts              # POST /api/demo/reset-baseline
|   |   |-- services/
|   |   |   |-- attentionScore.service.ts     # 0-100 scoring engine
|   |   |   |-- stockIntelligence.service.ts  # Per-stock full intelligence bundle
|   |   |   |-- marketData.service.ts         # Quote fetch + Redis cache + fallback
|   |   |   |-- digest.service.ts             # Watchlist headline digest
|   |   |   |-- metrics.service.ts            # Empirical percentiles, betas, regimes
|   |   |   |-- eventDetection.service.ts     # Corporate action event detection
|   |   |   |-- explanation.service.ts        # Human-readable reason bullets
|   |   |   |-- statistics.service.ts         # Median, MAD, rolling stats
|   |   |   |-- circuitBreaker.ts             # Per-dependency circuit breakers
|   |   |   |-- clock.ts                      # Replay clock (DEMO_AS_OF)
|   |   |   |-- log.ts                        # Redacting logger
|   |   |   |-- marketProvider.ts             # Provider dispatch (yahoo/groww)
|   |   |   |-- marketStatus.ts               # NSE session status
|   |   |   |-- ownership.ts                  # Watchlist ownership checks
|   |   |   |-- validate.ts                   # Input validation helpers
|   |   |   |-- jobLock.ts                    # Distributed job lock (advisory)
|   |   |   |-- demo/
|   |   |   |   |-- baseline.ts               # Demo baseline snapshot
|   |   |   |   |-- provider.ts               # Replay data provider
|   |   |   |   `-- reset.ts                  # Reset user state to baseline
|   |   |   |-- fundamentals/
|   |   |   |   |-- sync.ts                   # NSE data sync + price re-basing
|   |   |   |   |-- parse.ts                  # Corporate action subject parser
|   |   |   |   |-- splitDetector.ts          # Statistical split/bonus detector
|   |   |   |   |-- adjustmentScan.ts         # Batch adjustment scanner
|   |   |   |   `-- context.ts                # Fundamentals context builder
|   |   |   |-- groww/
|   |   |   |   |-- client.ts                 # Groww HTTP client
|   |   |   |   |-- auth.ts                   # Groww authentication
|   |   |   |   |-- adapter.ts                # Groww -> NormalizedQuote adapter
|   |   |   |   `-- provider.ts               # Groww market provider
|   |   |   |-- nse/
|   |   |   |   `-- client.ts                 # NSE India HTTP client
|   |   |   |-- sectors/
|   |   |   |   `-- sync.ts                   # Nifty 500 sector-index sync
|   |   |   `-- yahoo/
|   |   |       `-- provider.ts               # Yahoo Finance provider (default)
|   |   `-- ws/
|   |       `-- gateway.ts                    # WebSocket pub/sub gateway
|   |-- run_migration.ts             # CLI migration runner
|   `-- Dockerfile.vercel            # Multi-stage Docker build for Vercel/Render
|
|-- frontend/                        # Next.js 16 / React 19 application
|   |-- app/
|   |   |-- layout.tsx               # Root layout with providers
|   |   |-- page.tsx                 # Landing / redirect to watchlists
|   |   |-- providers.tsx            # TanStack Query + auth context
|   |   |-- (auth)/
|   |   |   |-- login/page.tsx       # Login page
|   |   |   `-- register/page.tsx    # Registration page
|   |   |-- watchlists/
|   |   |   |-- page.tsx             # Watchlist list page
|   |   |   `-- [id]/page.tsx        # Watchlist detail + summary dashboard
|   |   |-- stocks/
|   |   |   `-- [instrumentId]/page.tsx  # Stock intelligence detail page
|   |   |-- explore/
|   |   |   `-- page.tsx             # Market-wide explore / ranking page
|   |   `-- api/[...path]/route.ts   # API proxy to backend
|   |-- components/                  # Reusable UI components
|   |-- lib/
|   |   |-- api-client.ts            # Typed fetch wrapper
|   |   |-- ws-client.ts             # WebSocket client with exponential backoff + jitter
|   |   |-- use-auth.ts              # Auth state hook
|   |   |-- browser-store.ts         # Client-side state helpers
|   |   |-- format.ts                # Number / date formatters
|   |   `-- query-keys.ts            # TanStack Query key factory
|   `-- types/api.ts                 # Shared API response types
|
|-- migrations/                      # Sequential PostgreSQL migration scripts
|   |-- 001_initial_schema.sql
|   |-- 002_fundamentals_and_statistics.sql
|   |-- 003_horizons_and_adjustment_guard.sql
|   |-- 004_intraday_bars.sql
|   |-- 005_horizon_alignment_and_scale_fixes.sql
|   `-- 006_user_stock_state_watchlist_isolation.sql
|
|-- internal/                        # Go package (experimental internal tooling)
|-- vercel.json                      # Vercel deployment config
|-- render.yaml                      # Render.com deployment config (backend Docker)
|-- DEPLOY.md                        # Step-by-step deployment guide
`-- requirement.txt                  # Exact dependency & tool versions
```

## Local Setup & Quickstart

### Prerequisites
- **Node.js**: `v20.0.0` or higher (`v24.x` LTS recommended)
- **npm**: `v10.0.0` or higher
- **PostgreSQL**: PostgreSQL 15+ database instance (or Supabase project)
- **Redis**: Redis 7+ instance (or Upstash Redis)

Detailed version specifications are documented in [`requirement.txt`](./requirement.txt).

### 1. Database Migrations
Apply the sequential schema migrations to your PostgreSQL database:
```bash
cd backend
npx tsx run_migration.ts                                       # 001_initial_schema.sql
npm run migrate -- 002_fundamentals_and_statistics.sql         # Fundamentals, events & metrics
npm run migrate -- 003_horizons_and_adjustment_guard.sql       # Multi-horizon & split detection
npm run migrate -- 004_intraday_bars.sql                       # 5-min intraday replay bars
npm run migrate -- 005_horizon_alignment_and_scale_fixes.sql   # Horizon alignment & scale fixes
npm run migrate -- 006_user_stock_state_watchlist_isolation.sql # Per-watchlist stock state isolation
```

### 2. Initial Data Sync & Statistics Backfill
Populate instruments, historical market data, and baseline statistical models:
```bash
npm run seed               # Load NSE equity universe & default demo user/watchlist
npm run sync:fundamentals  # Sync NSE corporate calendars & Nifty-500 sector mappings
npm run backfill           # Backfill ~1 year of daily candles for stocks, Nifty 50, & VIX
npm run stats              # Calculate trailing statistics, medians, MADs, and market regime
```

### 3. Start Development Servers
```bash
# Terminal 1: Backend (:8080)
cd backend
npm run dev

# Terminal 2: Frontend (:3000)
cd frontend
npm run dev
```

**Default Demo Login Credentials:**
- **Email:** `demo@growwatch.local`
- **Password:** `Demo@12345`

---

## Demo Mode - Real Market Session Replay

Demoing "what changed since you last checked" during off-market hours requires an active, moving market. The `DEMO_AS_OF` engine replays a real past trading session using actual 5-minute intraday tick history without synthetic simulation:

```bash
# backend/.env configuration
DEMO_AS_OF=2026-09-04                             # Historical session date to replay
DEMO_SPEED=6                                      # 6 demo seconds per real second (session ~62 min)
DEMO_SESSION_START=09:15                          # Market open timestamp
DEMO_LABEL=on                                     # Display "Replay" badge in frontend
DEMO_AUTO_ACK=off                                 # Freeze baseline so the visit story persists
DEMO_BASELINE_AT=2026-08-31T10:00:00+05:30       # Historical "last visited" baseline timestamp
```

### Replay Commands
```bash
npm run demo:seed            # Backfills ~18 months daily history + exact 5-min replay session candles
npm run dev                  # Launches backend with simulated market clock starting at 09:15 IST
npm run demo:reset           # Re-arms the baseline to DEMO_BASELINE_AT
npm run demo:reset 90        # Or sets baseline to 90 minutes into the session ("checked mid-morning")
```

- **`DEMO_AUTO_ACK=off`**: In production, viewing the dashboard updates your baseline after 3 seconds. For demonstration purposes, auto-acknowledgement is disabled so the opening story remains visible until explicitly cleared with *"Mark all as seen"*.
- **Write-Safe Replay**: Only the market-refresh worker runs during replay mode; batch rollup jobs are safely held to prevent overwriting genuine historical records.

---

## Backend Scripts Reference

| Command | Description |
|---|---|
| `npm run dev` | Starts backend API server, background workers, and WebSocket gateway |
| `npm run migrate -- <file.sql>` | Applies a migration script recorded in `schema_migrations` |
| `npm run seed` | Seeds NSE instruments master, demo user account, and default 20-stock watchlist |
| `npm run sync:fundamentals` | Pulls NSE corporate results calendar, dividends, splits, and sector mappings |
| `npm run backfill` | Ingests ~250 trading days of historical candles for watchlist stocks and indices |
| `npm run stats` | Recomputes rolling medians, MADs, empirical percentiles, and market regimes |
| `npm run detect:splits` | Statistical corporate action scanner. Run `-- --apply` to commit re-basing |
| `npm run demo:seed` | Prepares historical replay data for `DEMO_AS_OF` |
| `npm run demo:reset [min]` | Resets user baseline state to demo baseline or $N$ minutes into the session |
| `npm run calibrate` | Replays scoring engine over dataset to output empirical quantile anchors |
| `npm test` | Runs comprehensive unit test suite (parsers, estimators, split detector, math) |

---

## Environment Configuration

### `backend/.env`
```ini
# Database & Cache
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:5432/[DB]?sslmode=require
REDIS_URL=rediss://default:[PASSWORD]@[HOST]:6379

# Server & Auth
PORT=8080
CORS_ORIGIN=http://localhost:3000
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRES_IN=7d

# Market Data Provider (yahoo | groww)
MARKET_DATA_PROVIDER=yahoo
GROWW_API_KEY=
GROWW_API_SECRET=

# Demo Replay Engine
DEMO_AS_OF=2026-09-04
DEMO_SPEED=6
DEMO_SESSION_START=09:15
DEMO_LABEL=on
DEMO_AUTO_ACK=off
DEMO_BASELINE_AT=2026-08-31T10:00:00+05:30
DEMO_LOOP=on
```

### `frontend/.env`
```ini
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
```

---

## Background Workers & Schedules

| Worker | Trigger / Interval | Responsibility |
|---|---|---|
| **market-refresh** | Every 30s (live session) / 5m (closed) | Fetches quotes for watched stocks $\rightarrow$ updates Redis cache, logs `market_snapshots`, broadcasts via WebSocket |
| **candle-rollup** | 15:45 IST (daily) | Aggregates daily intraday snapshots into permanent `daily_candles` |
| **stats-recalc** | 16:00 IST (daily) | Recalculates medians, MADs, empirical percentiles, market betas, and `market_regime` |
| **fundamentals-sync**| 18:30 IST (weekdays) | Ingests NSE corporate filings, results calendar, dividend ex-dates |
| **adjustment-scan** | Saturday 04:00 IST | Scans price history for clean split/bonus ratios; flags `SUSPECTED_ADJUSTMENT` entries |
| **sector-sync** | Sunday 02:30 IST | Maps Nifty 500 constituent industry codes to NSE sector indices |
| **snapshot-cleanup**| Daily 02:30 IST | Retains 7 days of rolling intraday snapshots; purges stale records |
| **instrument-sync** | Daily 03:00 IST | Syncs instrument master definitions from exchange CSV |

---

## API Reference

All routes except `/api/auth/*` require an `Authorization: Bearer <JWT>` header.

### Core Endpoints

**Auth**
- `POST /api/auth/register` x `POST /api/auth/login`

**Watchlists**
- `GET /api/watchlists` x `POST /api/watchlists` x `DELETE /api/watchlists/:id`
- `POST /api/watchlists/:id/stocks` x `DELETE /api/watchlists/:id/stocks/:instrumentId`
- `GET /api/watchlists/:id/summary?horizon=AUTO|DAY|WEEK|MONTH`
- `POST /api/watchlists/:id/acknowledge`
- `GET /api/watchlists/:id/alerts` x `POST /api/watchlists/:id/alerts` x `DELETE /api/watchlists/:id/alerts/:alertId`

**Market & Instruments**
- `GET /api/market/quotes?ids=NSE:INFY,NSE:TCS`
- `GET /api/market/:instrumentId/history?range=1M`
- `GET /api/instruments/search?q=tata` (rate-limited to 20 req/min)

**Stock Intelligence**
- `GET /api/stocks/:instrumentId/intelligence` - Full attention score + breakdown + explanation
- `GET /api/stocks/:instrumentId/chart` - OHLCV candle series for the chart panel

**Explore**
- `GET /api/explore?category=gainers|losers|meaningful|active|volume|sector` - Market-wide ranking from stored data (no per-row live calls)

**Demo Mode** *(only active when `DEMO_AS_OF` is set)*
- `POST /api/demo/reset-baseline` - Resets the authenticated user's baseline to `DEMO_BASELINE_AT`
- `POST /api/watchlists/:id/demo/replay` - Rewinds the demo session clock to baseline for the specific watchlist

**Health & Admin**
- `GET /health` - Liveness probe; reports clock mode, pool counts, Redis state, circuit-breaker statuses
- `GET /api/admin/migrate` - Applies any pending auto-migrations (safe to call repeatedly)

**WebSocket**
- `WS /ws?token=<JWT>` - Subscribes to live price and attention-score updates


---

## Safety, Resilience & Production Guardrails

| Concern | Architectural Solution | Implementation |
|---|---|---|
| **Idempotency** | Corporate action adjustments re-scale price history and flag the event inside an atomic SQL transaction (`withTransaction`). Crashes roll back cleanly without risk of double-scaling ($factor^2$). | `services/fundamentals/sync.ts` |
| **Circuit Breakers** | Isolated state machines monitor external upstreams (Yahoo, Groww, NSE, CSV feeds). Consecutive failures trip to open state; reported via `/health`. | `services/circuitBreaker.ts` |
| **Graceful Degradation** | Redis is strictly a non-blocking cache. Cache misses or Redis outages seamlessly degrade to direct database or provider queries without 500 errors. | `services/marketData.service.ts` |
| **PostgreSQL Keepalives** | Cloud poolers (e.g. Supabase PgBouncer) drop idle TLS sockets. Explicit TCP keepalives and statement timeouts prevent 100s pool hangs. | `config/db.ts` |
| **WebSocket Reconnect Jitter** | Full-jitter exponential backoff (1s base, 30s cap) on every `onclose` event. A `stableAfterMs` guard prevents the retry counter from resetting until the connection has stayed up for 10 s, so a server that accepts then immediately closes (e.g. setup failure) cannot create a 1-second reconnect storm. | `frontend/lib/ws-client.ts` |
| **Data Masking** | Loggers automatically scrub auth tokens, connection strings, JWTs, and passwords by structure and shape before output. | `services/log.ts` |
