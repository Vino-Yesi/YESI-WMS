# YESI-WMS — Modern Enterprise Fulfillment Architecture & Operations Guide

## 1. System Blueprint Overview

YESI-WMS has been upgraded from an isolated IndexedDB Lite app into a **Hybrid Cloud + Warehouse Edge Fulfillment WMS** built around PostgreSQL ACID guarantees, Supabase Realtime, Edge Functions, and sub-10ms offline floor resilience.

| Layer | Technology | Responsibility |
|---|---|---|
| **Core Database** | **Supabase PostgreSQL 17/18** | 12-domain relational schema, `FOR UPDATE` ACID stock locks, immutable double-entry ledger, FEFO allocation |
| **Security & Auth** | **PostgreSQL `pgcrypto` (bcrypt) + RLS + Web Crypto PBKDF2-SHA256** | Zero plaintext passwords; row-level security on all 33 `wms_*` tables; role-based permissions (`admin`, `supervisor`, `operator`, `auditor`, `viewer`) |
| **API & Edge Compute** | **Supabase PostgREST + Edge Function (`wms-api`)** | Health checks, Prometheus metrics (`/wms-api?action=metrics`), webhook ingestion (`wms_webhook_inbox`), transactional outbox publishing |
| **Realtime Bus** | **Supabase Realtime (`supabase_realtime`)** | Instant multi-terminal floor updates across inventory balances, orders, pick tasks, putaway, QC holds, and shipments |
| **Object Storage (S3)** | **Supabase Storage** | `wms-labels` (PDF/PNG carrier labels), `wms-pod-media` (dispatch proof photos/videos), `wms-documents` (ASN/XLSX/GRN docs) |
| **Warehouse Edge DB** | **Dexie (IndexedDB) + Outbox Sync Engine** | Offline-first RF scanner & floor operations with idempotent replay (`wms_sync_outbox_v1`) when Wi-Fi reconnects |
| **Web / Desktop / Mobile** | **React 19 + TypeScript + Vite 7 + PWA + Tauri v2** | Responsive Control Tower, RF/camera barcode scanning, Windows `.exe`/`.msi`, iOS/Android PWA |
| **Deployment & Monitoring** | **Docker + Nginx + GitHub Actions + Prometheus + Grafana** | Containerized SPA delivery, CI lint/typecheck/E2E gates, real-time warehouse KPI & latency scraping |

---

## 2. 12-Domain PostgreSQL Schema (`public.wms_*`)

All migrations are versioned in Supabase (`001` through `005`):

1. **01. Core (`wms_tenants`, `wms_companies`, `wms_warehouses`, `wms_roles`, `wms_users`, `wms_configurations`)** — Multi-tenant & multi-warehouse isolation (`DXB-FC1` Dubai Silicon Oasis Pilot + `SHJ-HUB2` Sharjah Hub).
2. **02. Master (`wms_uoms`, `wms_products`, `wms_skus`, `wms_barcodes`, `wms_suppliers`, `wms_customers`, `wms_carriers`)** — Multi-barcode SKU master, ABC/velocity classes, dimensions, reorder points.
3. **03. Location (`wms_zones`, `wms_locations`)** — Zone → Aisle → Rack → Shelf → Bin hierarchy, temperature zones, pick sequence numbers, weight/unit capacities.
4. **04. Inbound (`wms_purchase_orders`, `wms_dock_appointments`, `wms_receipts`, `wms_qc_inspections`, `wms_putaway_tasks`)** — ASN/PO scheduling, dock check-in, GRN generation, quarantine holds, directed putaway.
5. **05. Inventory (`wms_lots`, `wms_inventory_balances`, `wms_inventory_ledger`, `wms_serial_numbers`, `wms_sim_tac_db`, `wms_reservations`, `wms_cycle_counts`)** — Generated `available_qty`, optimistic `version` + `FOR UPDATE` row locks, immutable ledger with `idempotency_key`, IMEI/TAC serial tracking.
6. **06. Outbound (`wms_waves`, `wms_sales_orders`, `wms_pick_tasks`, `wms_box_types`, `wms_cartons`, `wms_pack_lines`)** — Marketplace/B2B orders, FEFO allocation, wave/batch picking, cartonization.
7. **07. Replenishment (`wms_replenishment_rules`, `wms_replenishment_tasks`, `wms_transfers`)** — Min/max forward-pick replenishment and inter-warehouse stock transfers.
8. **08. Transport (`wms_shipments`, `wms_posting_records`)** — Carrier rate shopping, label generation, tracking numbers, and photo/video Proof-of-Dispatch (POD).
9. **09. Returns (`wms_returns`)** — RMA authorization, A/B/C/Defective grading, restock vs. QC hold disposition.
10. **10. Integration (`wms_integration_endpoints`, `wms_event_outbox`, `wms_webhook_inbox`, `wms_connected_devices`, `wms_gsheet_links`, `wms_templates`)** — Transactional Outbox & idempotent Webhook Inbox.
11. **11. Audit & Labor (`wms_audit_logs`, `wms_worker_tasks`, `wms_operator_stats`)** — Immutable user activity trail, UPH labor tracking, operator XP progression.
12. **12. Reporting (`v_wms_kpi_summary`, `wms_system_metrics`)** — Real-time SQL KPI aggregation view & Prometheus metrics exporter.

### Core ACID Stored Procedures (PostgreSQL RPCs)
- `wms_authenticate_user(p_username, p_password, p_tenant_code)` — Server-side `pgcrypto` bcrypt authentication + audit logging.
- `wms_upsert_user_secure(...)` — Server-side bcrypt user creation & role/password management.
- `wms_record_stock_movement(...)` — Acquires `FOR UPDATE` lock on `wms_inventory_balances`, enforces non-negative stock, appends `wms_inventory_ledger`, and emits `wms_event_outbox` with idempotency deduplication.
- `wms_receive_inbound_grn(...)` — Creates GRN receipt, routes failed items to `wms_qc_inspections` or passed items to stock + directed `wms_putaway_tasks`.
- `wms_allocate_order_fefo(...)` — Reserves earliest-expiring stock (`ORDER BY expiry_date ASC NULLS LAST`) and generates `wms_pick_tasks`.
- `wms_dispatch_order(...)` — Deducts reserved & on-hand stock, closes pick tasks, records `wms_shipments`, marks order `Shipped`, and queues `ORDER_SHIPPED` outbox event.

---

## 3. Standard Fulfillment SOPs (End-to-End Operational Workflow)

1. **Inbound & Receiving (`/dock` → `/inbound` → `/qc` → `/putaway`)**
   - Schedule carrier arrival in **Dock & ASN**, check in trailer at `DOCK-01..04`.
   - Scan supplier cartons/PO lines in **Inbound GRN** (`wms_receive_inbound_grn`).
   - Inspect flagged lots in **QC Inspection**; release approved stock to **Directed Putaway** (`wms_putaway_tasks`) scored by velocity, category, and bin capacity.
2. **Inventory & Replenishment (`/inventory`, `/serial-tracking`, `/replenishment`, `/cycle-count`)**
   - Capture smartphone/wearable IMEIs and validate TAC prefixes in **Serial / IMEI** & **SIM / TAC DB**.
   - Execute ABC **Cycle Counts** and trigger **Min/Max Replenishment** to keep forward-pick bins (`PHONE-A-01`, `WEAR-B-01`, `AUDIO-C-01`) stocked.
3. **Outbound Wave, Pick, Audit & Dispatch (`/daily`, `/pick-pack`, `/batch-pick`, `/auditor`, `/shipping`, `/posting`)**
   - Import or sync marketplace postings (Ozon / Wildberries / G-Sheets).
   - Run **FEFO Allocation** (`wms_allocate_order_fefo`) and **Quantum Route 2-Opt** path optimization.
   - Sequence thermal labels via **PDF Sequencer**, verify scans in **Pack Auditor**, print carrier manifest in **Shipping** (`wms_dispatch_order`), and capture POD photo/video in **POD Tracker**.
4. **Returns / RMA (`/returns`)**
   - Scan returning order/SKU; grade condition (`A` restocks automatically into bin + ledger; `Defective` routes automatically to `wms_qc_inspections`).

---

## 4. Build, Deployment & Real-World Monitoring Procedures

### Local Development
```bash
cp .env.example .env
npm install --legacy-peer-deps
npm run dev          # Starts Vite on 0.0.0.0:3000
npm run lint         # ESLint static analysis (0 errors)
npm run build        # TypeScript strict build + PWA Service Worker
npm run test:e2e     # Playwright end-to-end fulfillment smoke suite
```

### Production Container & Observability Stack
```bash
docker compose up -d --build
```
- **Web App (Nginx + SPA + `/healthz`)**: `http://localhost:8080`
- **Prometheus Scraper**: `http://localhost:9090` (scrapes Supabase Edge `/functions/v1/wms-api?action=metrics`)
- **Grafana Dashboards**: `http://localhost:3001`
- **In-App Cloud Telemetry**: Navigate to `/cloud` (**Cloud & DB**) inside YESI-WMS to inspect live Edge Gateway latency, switch warehouses (`DXB-FC1` / `SHJ-HUB2`), inspect `wms_inventory_ledger`, and publish `wms_event_outbox` events.
