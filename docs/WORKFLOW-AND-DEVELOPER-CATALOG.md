# YESI-WMS v2.1 Enterprise — Master Workflow, Progress & Developer Operations Catalog

> **Document Purpose**: Unified operational, architectural, workflow, build, testing, and deployment catalog for **YESI-WMS Enterprise v2.1** (`Vino-Yesi/YESI-WMS`). Covers end-to-end warehouse fulfillment workflows, project progress & completed hardening milestones, performance engineering, and step-by-step developer SOPs for local development, quality gates, database/Edge deployment, desktop/mobile builds, and production operations.

---

## Part I — Project Progress & Milestone Catalog

| Phase | Domain | Status | Key Deliverables & Files |
| :--- | :--- | :---: | :--- |
| **Phase 1** | **12-Domain Relational Core & RLS** | Completed | `50` PostgreSQL `wms_*` tables across 12 domains (`supabase/migrations/001..007`), `0` tables without RLS, `0` `SECURITY DEFINER` RPCs without pinned `search_path`. |
| **Phase 2** | **Zero-Secret Config & Session Security** | Completed | Strict runtime validator (`src/lib/config.ts`), client secret leak blocker (`scripts/security-check.mjs`), non-extractable Web Crypto `AES-256-GCM` session envelope (`src/lib/security.ts`), `PBKDF2-SHA256` offline auth + `pgcrypto` cloud auth (`src/lib/auth.tsx`), progressive brute-force lockout, and warehouse-scoped RBAC (`DXB-FC1`, `MSK-HUB2`). |
| **Phase 3** | **Atomic 8-Stage Fulfillment Lifecycle** | Completed | Transactional Dexie + PostgreSQL RPC engine (`src/lib/lifecycle.ts`, `src/lib/allocation.ts`) spanning **Inbound GRN → QC Hold/Release → Directed Putaway → All-or-Nothing FEFO Allocation → Pick → Pack → Carrier Dispatch → Returns/RMA**, backed by immutable double-entry stock ledger entries. |
| **Phase 4** | **Hybrid Outbox Sync & Conflict Resolution** | Completed | Idempotent outbox queue (`src/lib/supabaseSync.ts`) with payload schema validation, exponential backoff + jitter, Dead-Letter Queue (DLQ) retry/inspection, stage-monotonic conflict resolution, and throttled Realtime sync. |
| **Phase 5** | **Cross-Origin Iframe & Floor Performance Hardening** | Completed | Non-throwing storage adapter (`src/lib/safeStorage.ts`) preventing `DOMException: SecurityError` crashes in cross-origin preview iframes / Safari ITP / kiosk modes; isolated `<LiveClock />` and `useRef` inactivity tracking eliminating 1 Hz / pointer-event TopBar & AuthContext re-renders; windowed virtualization (`InventoryHub.tsx`) and parallel indexed queries (`Dashboard.tsx`). |
| **Phase 6** | **CI/CD, Multi-Platform Build & Observability** | Completed | GitHub Actions secret/lint/unit/dual-mode build pipeline (`.github/workflows/ci-cd.yml`), Supabase Edge Function `wms-api` (health, Prometheus metrics, webhook inbox, outbox flush), Docker + Nginx + Prometheus + Grafana stack, PWA offline service worker, and Tauri v2 desktop/mobile build targets. |

---

## Part II — End-to-End Warehouse Workflow Catalog

### 1. 8-Stage Transactional Fulfillment Pipeline

```text
[Stage 1: Dock & Inbound GRN] ──► [Stage 2: QC Inspection] ──► [Stage 3: Directed Putaway]
          (/dock, /inbound)                 (/qc)                       (/putaway)
                                                                            │
                                                                            ▼
[Stage 6: Pack & Weight Audit] ◄── [Stage 5: Wave / Floor Pick] ◄── [Stage 4: FEFO Allocation]
     (/pick-pack, /auditor)          (/pick-pack, /batch-pick)        (allocation.ts / RPC)
                │
                ▼
[Stage 7: Carrier Dispatch & POD] ──► [Stage 8: RMA & Returns Disposition]
      (/shipping, /posting)                        (/returns)
```

| Stage | Route(s) | Required RBAC Permission | Core Engine / RPC | Operational Workflow & Invariants |
| :--- | :--- | :--- | :--- | :--- |
| **1. Dock & Inbound Receiving** | `/dock`, `/inbound` | `dock.view`, `inbound.execute` | `receiveInboundTransactional` / `wms_receive_inbound_grn` | Schedule ASN/trailer at dock (`DOCK-01..04`), scan supplier SKU/PO or upload Excel manifest, record GRN receipt in `RECV-DOCK-01`, log immutable `inbound` ledger delta, and auto-route passed vs. failed lots. |
| **2. Quality Control (QC)** | `/qc` | `qc.inspect`, `qc.release` *(Supervisor/Admin)* | `resolveQcHoldTransactional` / `wms_resolve_qc_hold` | Flagged or defective lots enter `QCHold` quarantine (`QC-HOLD-01`). Only `supervisor` or `admin` roles can execute **Release** (generates directed putaway task) or **Scrap** (writes `scrap` write-off ledger entry). |
| **3. Directed Putaway** | `/putaway` | `putaway.execute` | `completePutawayTransactional` / `wms_complete_putaway` | Scores optimal destination bin (`PHONE-A-01`, `WEAR-B-01`, `AUDIO-C-01`) by SKU velocity, category, and zone capacity. Blocks putaway if `qcStatus !== 'passed'`, moves stock to active bin, and increments zone utilization. |
| **4. All-or-Nothing FEFO Allocation** | `/pick-pack`, `/batch-pick`, `/ozon-sheets` | `outbound.execute` | `allocateOrderFEFO` / `wms_allocate_order_fefo` | Sorts candidate lots by earliest `expiryDate` (`FEFO`), then `fefoPriority`, then `FIFO`. Enforces **all-or-nothing** reservation: if any SKU line is short, zero partial reservations leak. |
| **5. Wave, Batch & Instant Pick** | `/daily`, `/batch-pick`, `/pick-pack` | `daily.execute`, `outbound.execute` | `routeOptimizer` (`compute.worker.ts`) | Nearest-neighbor + 2-Opt **Quantum Route** pathing across warehouse zones; supports single-order, batch, zone, and 5-step Daily Instant Wave fulfillment. |
| **6. Pack & Barcode/Weight Audit** | `/pick-pack`, `/auditor` | `outbound.pack` | `confirmOrderPackedTransactional` / `validateScan` | Carton recommendation (`BoxSize`), scan-by-scan verification (`VALID`, `PARTIAL`, `QTY_EXCEEDED`, `UNKNOWN_ORDER`), transitions order `Picking → Packed → ReadyToShip`, and awards operator XP. |
| **7. Carrier Dispatch & POD** | `/shipping`, `/posting` | `outbound.ship` | `dispatchOrderTransactional` / `wms_dispatch_order` | Rate-shops active carriers, generates tracking number & `ShippingLabel`, deducts physical stock (`outbound` ledger), closes reservations (`picked`), marks order `Shipped`, and captures photo/video Proof-of-Dispatch (`PostingTracker`). |
| **8. Returns & RMA Grading** | `/returns` | `returns.execute` | `processReturnTransactional` / `wms_process_return_rma` | Grades returned items: **Restockable (Grade A)** increments sellable stock + creates `returns` putaway task; **Damaged/Defective** routes directly to `qcHolds` quarantine without polluting sellable inventory. |

---

### 2. Complete Application Module & Route Directory (29 Modules)

| Domain | Module | Route | Permission Gate | Primary Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **01. Control** | Control Tower Dashboard | `/` or `/dashboard` | `dashboard.view` | Live KPIs, stockout forecasts, low-stock alerts, recent movements |
| **01. Control** | Daily Instant Manual | `/daily` | `daily.execute` | 5-step Ozon/marketplace wave receive → sequence → audit → ship → summary |
| **01. Control** | Workflow Blueprint | `/workflow` | `workflow.view` | Visual interactive map of warehouse stages & live bottlenecks |
| **01. Control** | Guardian Ops Center | `/guardian` | `guardian.view` | Pressure scenarios, dynamic operational adaptation, DB cleanup |
| **01. Control** | Cloud Core & Telemetry | `/cloud` | `cloud.view` | Supabase Edge health, warehouse switcher, SQL ledger & outbox monitor |
| **04. Inbound** | Dock Scheduling & ASN | `/dock` | `dock.view` | Yard/trailer appointments, check-in, dock door status |
| **04. Inbound** | Inbound Receiving & GRN | `/inbound` | `inbound.execute` | Manual RF scan, XLSX manifest import, PO line reconciliation |
| **04. Inbound** | Quality Inspection | `/qc` | `qc.inspect` | Quarantine holds, defect inspection, supervisor release/scrap |
| **04. Inbound** | Directed Putaway | `/putaway` | `putaway.execute` | Slotting-scored putaway queue & bin confirmation |
| **05. Inventory** | Inventory Hub & Oracle | `/inventory` | `inventory.view` | Virtualized master SKU table, ABC classes, 7-day Oracle forecast, Sentinel |
| **05. Inventory** | Serial & IMEI Tracking | `/serial-tracking` | `serial.track` | End-to-end IMEI1/IMEI2/serial lifecycle & warranty chain |
| **05. Inventory** | ABC Cycle Counting | `/cycle-count` | `cycle_count.execute` | Blind/guided bin counts & variance reconciliation |
| **07. Replenish** | Min/Max Replenishment | `/replenishment` | `replenishment.execute` | Forward-pick bin auto-replenishment tasks |
| **06. Outbound** | Pick & Pack Station | `/pick-pack` | `outbound.execute` | Order FEFO allocation, pick confirmation, box sizing, pack sign-off |
| **06. Outbound** | Wave & Batch Pick Center | `/batch-pick` | `outbound.execute` | Multi-order wave grouping & Quantum 2-Opt pick pathing |
| **08. Transport** | Carrier Dispatch & Manifest | `/shipping` | `outbound.ship` | Rate shopping, thermal label print, atomic dispatch |
| **08. Transport** | POD Tracker | `/posting` | `outbound.ship` | Camera photo/video + geolocation Proof-of-Dispatch |
| **09. Returns** | RMA & Returns | `/returns` | `returns.execute` | Return grading, restock vs. quarantine disposition |
| **10. Floor Tools** | PDF Label Sequencer | `/pdf-sequencer` | `tools.use` | Ozon/WB thermal PDF page reordering to match pick sequence |
| **10. Floor Tools** | Pack & Weight Auditor | `/auditor` | `outbound.pack` | High-speed barcode & carton verification station |
| **10. Floor Tools** | RF / Camera Scanner | `/barcode-scanner` | `tools.use` | Hardware wedge / mobile camera QR & 1D barcode scanner |
| **10. Floor Tools** | Location & SKU Barcodes | `/barcode-generator` | `tools.use` | Batch PNG/ZIP/Sheet generator for bin, EAN-13, and IMEI labels |
| **10. Floor Tools** | SIM / IMEI TAC Registry | `/sim-manager` | `tools.use` | GSMA TAC prefix lookup & device model registry |
| **10. Floor Tools** | Ozon Live Sheet Pipeline | `/ozon-sheets` | `tools.use` | Automated Google Sheets → WMS order ingestion & FEFO auto-allocation |
| **10. Floor Tools** | Daily G-Sheet Tracker | `/gsheet` | `tools.use` | Client expected vs. packed quantity sheet tracker |
| **10. Floor Tools** | SKU Mapping Templates | `/templates` | `tools.use` | Raw marketplace title → canonical warehouse SKU mapper |
| **10. Floor Tools** | Bulk Data Converter | `/bulk-convert` | `tools.use` | Batch CSV/TSV/XLSX normalization utility |
| **11/12. Admin** | ERP / OMS Integration Hub | `/integrations` | `integrations.manage` | Webhook/API connectors & sync telemetry *(Supervisor+)* |
| **11/12. Admin** | Labor & UPH Management | `/labor` | `labor.manage` | Worker task assignment, Units-Per-Hour (UPH), accuracy *(Supervisor+)* |
| **11/12. Admin** | Operational Analytics | `/analytics` | `reports.view` | Throughput, SLA, carrier cost, and ABC value charts |
| **11/12. Admin** | Warehouse Rules & Memory | `/memory` | `memory.manage` | Aliases, slotting preferences, and automation rules *(Supervisor+)* |
| **11/12. Admin** | RBAC User & Audit Mgmt | `/users` | `users.manage` | Operator provisioning, role assignment, immutable audit log *(Admin)* |
| **11/12. Admin** | System Settings | `/settings` | `dashboard.view` | UI density (`compact`/`comfortable`), JSON backup/restore, diagnostics |

---

## Part III — Performance & Reliability Architecture

1. **Sandboxed Storage Resilience (`src/lib/safeStorage.ts`)**:
   - Wraps `localStorage`, `sessionStorage`, `matchMedia`, and `crypto.randomUUID` with non-throwing adapters + in-memory mirrors. Prevents `DOMException: SecurityError` crashes in cross-origin preview iframes, Safari ITP, private browsing, and quota-full warehouse tablets.
2. **Zero-Jank Render Isolation**:
   - `TopBar.tsx` isolates the 1-second clock inside `<LiveClock />` so notifications, XP popovers, and `SyncStatus` never re-render on clock ticks.
   - `auth.tsx` tracks rolling 45-minute inactivity via `lastActivityRef` instead of React state, avoiding full-app context re-renders on `scroll`/`mousedown`/`keydown`.
   - `CommandPalette.tsx` only mutates store state on `Escape` when the palette is open.
3. **High-Density Floor Virtualization & Parallel Queries**:
   - `InventoryHub.tsx` uses windowed viewport slicing (`ROW_HEIGHT = 44px` + overscan) to sustain 60 FPS with 10,000+ SKUs.
   - `Dashboard.tsx` executes 9 parallel indexed Dexie count/limit queries via `Promise.all`.
   - Heavy TSP 2-Opt route optimization and 7-day demand forecasting run off the main thread in `src/workers/compute.worker.ts`.
4. **Vendor Chunk Splitting (`vite.config.ts`)**:
   - Splits `vendor-pdf`, `vendor-scanner`, `vendor-supabase`, `vendor-ui`, and `vendor-react` (with `resolve.dedupe` for React 19 / React Router 7) while lazy-loading all 29 route pages.

---

## Part IV — Developer Guide: Build, Develop & Deployment Procedures

### 1. Prerequisites
- **Node.js**: `v20 LTS` or `v22+` (`npm 10+`)
- **Optional (Desktop / Native Mobile)**: Rust stable toolchain (`rustup`), Tauri CLI v2 (`@tauri-apps/cli`), Windows WebView2 / MSVC or Xcode / Android SDK
- **Optional (Containerized Ops Stack)**: Docker Engine `24+` & Docker Compose `v2`
- **Optional (Cloud Mode)**: Supabase project (`PostgreSQL 17+` with `pgcrypto` enabled)

---

### 2. Local Environment Setup & Operating Modes

YESI-WMS supports two deterministic operating modes controlled strictly via environment variables:

#### Mode A — Offline-Edge Mode (Zero Cloud Dependencies)
Runs 100% locally on IndexedDB (`Dexie`) + Web Crypto `PBKDF2-SHA256` + `AES-256-GCM`.
```bash
git clone https://github.com/Vino-Yesi/YESI-WMS.git
cd YESI-WMS
npm install --legacy-peer-deps
npm run dev -- --host 0.0.0.0 --port 3000
```
- **Default Seeded Local Accounts** (provisioned automatically in IndexedDB on first boot):
  - `admin` / `admin` (Role: `admin`, Warehouses: `DXB-FC1`, `MSK-HUB2`)
  - `VINOVJ` / `VINOVJ` (Role: `admin`, Warehouses: `DXB-FC1`, `MSK-HUB2`)
  - `supervisor` / `supervisor` (Role: `supervisor`, Warehouse: `DXB-FC1`)
  - `operator` / `operator` (Role: `operator`, Warehouse: `DXB-FC1`)

#### Mode B — Hybrid Cloud-Connected Mode (Supabase PostgreSQL + Edge + Realtime)
1. Copy `.env.example` to `.env` (gitignored):
   ```bash
   cp .env.example .env
   ```
2. Populate `.env` with **publishable** client configuration only:
   ```dotenv
   VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-publishable-anon-key>
   VITE_WMS_TENANT_CODE=YESI-CORP
   VITE_WMS_DEFAULT_WAREHOUSE=DXB-FC1
   ```
   > **Security Rule**: Never place `SUPABASE_SERVICE_ROLE_KEY` or `sb_secret_*` keys in `.env` or any `VITE_*` variable. Both `src/lib/config.ts` (at runtime) and `scripts/security-check.mjs` (at build/CI time) actively block privileged keys.

---

### 3. Daily Developer Commands & Quality Gates

Run all four verification gates before opening or updating any pull request:

```bash
# 1. Secret & Credential Leak Gate (scans all git-tracked files)
npm run check:security

# 2. Unit & Core Invariant Suite (Vitest: config, crypto, RBAC, outbox, scan, route, iframe storage)
npm test

# 3. Static Analysis (ESLint 9 + TypeScript-ESLint — must report 0 errors)
npm run lint

# 4. Production Typecheck + Bundle + PWA Build (Cloud + Offline-Edge verification)
npm run build
VITE_SUPABASE_URL="" VITE_SUPABASE_ANON_KEY="" npm run build

# 5. Preview Production Bundle Locally on Port 3000
npm run preview -- --host 0.0.0.0 --port 3000
```

End-to-End Browser Testing (Playwright):
```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

---

### 4. Database Migration & Supabase Edge Function Deployment SOP

When provisioning a new Supabase environment or promoting schema changes:

1. **Apply SQL Migrations in Order**:
   Apply migrations under `supabase/migrations/` sequentially (`001` through `20261114_006_007_enterprise_security_and_lifecycle.sql`) via Supabase CLI or SQL Editor:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
2. **Verify RLS & Security Definer Hardening**:
   Run this verification query in Supabase SQL Editor — both counts **must** equal `0`:
   ```sql
   SELECT
     (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'wms_%' AND NOT rowsecurity) AS tables_without_rls,
     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'wms_%' AND p.prosecdef AND p.proconfig IS NULL) AS secdef_without_search_path;
   ```
3. **Configure Edge Function Secrets & Deploy `wms-api`**:
   ```bash
   npx supabase secrets set WMS_ALLOWED_ORIGINS="https://your-production-domain.com"
   npx supabase secrets set WMS_METRICS_TOKEN="<strong-random-prometheus-bearer-token>"
   npx supabase functions deploy wms-api
   ```
4. **Verify Edge Gateway Health**:
   ```bash
   curl -s "https://<your-project-ref>.supabase.co/functions/v1/wms-api?action=health&warehouse=DXB-FC1" \
     -H "apikey: <your-anon-key>"
   ```

---

### 5. Production Deployment Procedures

#### Option A — Docker + Nginx + Prometheus + Grafana (Recommended Self-Hosted / Warehouse Server)
`Dockerfile` performs a multi-stage Node 20 Alpine build and serves `dist/` via hardened Nginx (`8080`) with SPA fallback and `/healthz` probes.
```bash
# Export build-time public variables (or pass via CI secrets)
export VITE_SUPABASE_URL="https://<your-project-ref>.supabase.co"
export VITE_SUPABASE_ANON_KEY="<your-publishable-anon-key>"
export VITE_WMS_TENANT_CODE="YESI-CORP"
export VITE_WMS_DEFAULT_WAREHOUSE="DXB-FC1"

docker compose up -d --build
```
- **WMS Web Application**: `http://localhost:8080` (Health probe: `http://localhost:8080/healthz`)
- **Prometheus Metrics UI**: `http://localhost:9090` (scrapes `wms-api?action=metrics`)
- **Grafana Operations Dashboards**: `http://localhost:3001`

#### Option B — Cloud Static / Edge Hosting (Vercel / Netlify / Cloudflare Pages)
- **Build Command**: `npm run build`
- **Publish Directory**: `dist`
- **Node Version**: `20`
- **SPA Rewrite Rule**: Rewrite all non-asset routes (`/*`) to `/index.html` (`200`), already configured in `netlify.toml`.
- **Environment Variables**: Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_WMS_TENANT_CODE`, and `VITE_WMS_DEFAULT_WAREHOUSE` in the hosting dashboard.

#### Option C — Native Desktop (`.exe` / `.msi`) & Mobile PWA
- **Windows Desktop (Tauri v2)**:
  ```bash
  npm run tauri:build
  # Artifacts generated in src-tauri/target/release/bundle/{msi,nsis}/
  ```
- **iOS / Android Floor Scanners (Installable PWA)**:
  - Deploy over HTTPS.
  - On iOS Safari: tap **Share → Add to Home Screen** (guided automatically by `InstallPrompt.tsx`).
  - On Android Chrome / Zebra RF Browser: tap **Install YESI Lite WMS** banner; Workbox caches all 64+ shell chunks for instant offline floor startup.

---

### 6. Incident Triage & Operational Runbook

| Symptom | Root Cause Check | Resolution Procedure |
| :--- | :--- | :--- |
| **`Application Error` screen on page** | Inspect `<pre>` diagnostic banner (now prints exact `DOMException` / chunk / component stack). | Click **Retry** (auto-reloads stale Vite/PWA chunks). Storage restrictions in cross-origin iframes are handled automatically by `safeStorage.ts`. |
| **TopBar shows `DLQ (N)` in SyncStatus** | An outbox item exceeded max retries or hit a business validation rule. | Open `/cloud` (**Cloud & DB**) to inspect outbox error details and trigger manual replay or warehouse reconciliation. |
| **Account Locked (`ACCOUNT_LOCKED`)** | 5+ consecutive failed password attempts triggered progressive lockout. | Wait 5 minutes for automatic cooldown expiry or have an `admin` reset the user in `/users`. |
| **`QC_CHECKPOINT_BLOCKED` on Putaway** | Operator attempted to put away a lot whose `qcStatus` is still `pending` or `failed`. | Have a `supervisor` or `admin` inspect and **Release** the hold in `/qc` first. |
