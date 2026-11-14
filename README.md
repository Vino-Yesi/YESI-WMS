# YESI-WMS v2.0 Enterprise — Hybrid Cloud + Offline-First Fulfillment Platform

**YESI-WMS v2.0 Enterprise** (`yesi-wms-enterprise`) is a full-scale, modern Warehouse Management System built across **12 standardized WMS domains**, powered by **Supabase PostgreSQL 17** (49 RLS-protected tables, ACID stored procedures, Realtime telemetry, and Edge Functions) paired with an **offline-first Dexie IndexedDB edge cache** and **transactional sync outbox** so warehouse RF scanners, mobile devices, and desktop workstations operate with sub-10ms scan latency even during Wi-Fi dropouts.

---

## Enterprise Architecture Highlights

- **12-Domain Fulfillment Schema (49 PostgreSQL Tables + 101 Indexes + 49/49 RLS Policies)**:
  1. `core` — Organizations (`YESI-FZCO`), Warehouses (`DXB-FC1`), Roles, Users (`pgcrypto` bcrypt), Sessions, Settings
  2. `master` — UOMs, Categories, Suppliers, Customers, Products, Barcodes (GS1/EAN/UPC/QR), Packaging Levels
  3. `location` — Zones, Aisles, Racks, Levels, Bins (`A-01-01-A`), Putaway Strategies (FEFO / Velocity / Fixed)
  4. `inbound` — Purchase Orders, ASNs, GRNs, Inbound Lines, QC Inspections, Directed Putaway Tasks
  5. `inventory` — Multi-dimensional Stock Balances (`AVAILABLE`, `RESERVED`, `ALLOCATED`, `QUARANTINE`, `DAMAGED`), Lots/Expiry, Serials/IMEI, Stock Ledger, Transfers, Adjustments, Cycle Counts
  6. `outbound` — Sales Orders, Wave Planning, Allocations, Pick Lists, Pick Tasks, Pack Stations, Cartons
  7. `replenish` — Min/Max Forward-Pick Rules & Directed Replenishment Tasks
  8. `transport` — Carriers (`GBS Express`, `Wildberries Logistics`, `DHL`), Shipments, Manifests, Dock Doors, Yard Appointments
  9. `returns` — RMA Headers, RMA Lines, Inspection & Disposition (`RESTOCK`, `QUARANTINE`, `SCRAP`, `RTV`)
  10. `integration` — Transactional Outbox (`wms_sync_outbox`), Webhook Subscriptions, Marketplace Order Sync
  11. `audit` — Immutable Audit Log, System Events, Exception Alerts
  12. `reporting` — Daily KPI Snapshots & Live `v_wms_kpi_summary` View
- **ACID Stored Procedures (`SECURITY DEFINER`, Row-Level Locking)**:
  - `wms_verify_operator_login` — Server-side `pgcrypto` bcrypt verification + audit logging
  - `wms_receive_inbound_grn` — Atomic GRN creation + Lot/Balance upsert + Stock Ledger + Directed Putaway Task generation
  - `wms_allocate_order_fefo` — `FOR UPDATE` row-locked FEFO stock reservation across bins & expiry dates
  - `wms_dispatch_order` — Atomic inventory deduction, carton/shipment manifest creation, and outbox event emission
- **Hardened Security & RBAC**:
  - Web Crypto **PBKDF2-SHA256** (120,000 iterations) local password hashing with automatic migration from legacy plaintext records
  - 5-tier granular RBAC (`admin`, `supervisor`, `operator`, `auditor`, `viewer`) across 15 permission scopes
  - Content Security Policy (CSP), HSTS, `X-Frame-Options: SAMEORIGIN`, and Supabase Row-Level Security
- **Supabase Edge Function Gateway (`wms-api`)**:
  - `GET ?action=health` — Live DB & warehouse health probe
  - `GET ?action=metrics` — Prometheus OpenMetrics scrape endpoint (`wms_inventory_on_hand_total`, `wms_orders_open_total`, `wms_sync_outbox_pending_total`, etc.)
  - `POST { action: "flush_outbox" }` — Idempotent edge-to-cloud batch sync processor
  - `POST { action: "webhook_order" }` — Marketplace / ERP order ingestion webhook
- **34 Unified Operational Modules**:
  - Real-time Cloud & Edge Telemetry (`#/cloud-monitor`), Wave & Pick-Path 2-Opt Optimizer, Wildberries PDF Sticker Cropper & Sequencer, GS1/Camera/HID Barcode Scanner, Oracle Demand Forecaster, Anomaly Sentinel, Digital Twin 3D View, Cycle Counting, Dock Scheduling, RMA Returns, and Tauri v2 Desktop/Mobile packaging.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (.env.example -> .env)
cp .env.example .env

# 3. Start development server (binds 0.0.0.0:3000)
npm run dev

# 4. Run unit tests, ESLint, and production build
npm test
npm run lint
npm run build
```

---

## Production Deployment & Observability

Full architecture diagrams, standard operating procedures (SOPs), and runbooks are documented in [`docs/ARCHITECTURE-AND-OPERATIONS.md`](docs/ARCHITECTURE-AND-OPERATIONS.md).

```bash
# Launch containerized Web App + Nginx + Redis + Prometheus + Grafana stack
docker compose up -d --build
```

| Service | Endpoint | Purpose |
|---------|----------|---------|
| WMS Web App (Nginx 1.27) | `http://localhost:8080` (`/healthz`) | SPA + PWA + Security Headers |
| Supabase Edge API | `/functions/v1/wms-api` | Health, Prometheus Metrics, Outbox Sync, Order Webhooks |
| Prometheus | `http://localhost:9090` | Scrapes `wms-api?action=metrics` every 30s |
| Grafana | `http://localhost:3001` | Real-time warehouse throughput & outbox lag dashboards |

---

## Default Role Credentials (`YESI-FZCO` / `DXB-FC1`)

| Username | Password | Role | Access Scope |
|----------|----------|------|--------------|
| `VINOVJ` | `VINOVJ` | `admin` | Full system, RBAC, Cloud Monitor, DB tools |
| `admin` | `admin` | `admin` | Full system administration |
| `supervisor` | `supervisor` | `supervisor` | Wave release, QC hold/release, Replenishment, Reports |
| `operator` | `operator` | `operator` | Inbound GRN, Putaway, Pick/Pack, Shipping, Cycle Count |
