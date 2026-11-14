import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Database,
  Server,
  ShieldCheck,
  Activity,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Warehouse,
  Layers,
  Send,
  HardDrive,
  ArrowUpDown,
  Lock,
  Cpu,
} from 'lucide-react';
import { supabase, SUPABASE_URL, WMS_TENANT_CODE, checkEdgeGatewayHealth, flushCloudOutbox, type WmsEdgeHealthResponse } from '@/lib/supabase';
import {
  getSyncState,
  subscribeSyncState,
  pullCloudSnapshotToEdge,
  drainLocalOutbox,
  listCloudWarehouses,
  setActiveWarehouseCode,
  type SyncSnapshotState,
} from '@/lib/supabaseSync';
import { useAuth } from '@/lib/auth';

interface LedgerRow {
  id: string;
  sku_code: string;
  transaction_type: string;
  qty_delta: number;
  balance_before: number;
  balance_after: number;
  to_location_code: string | null;
  from_location_code: string | null;
  reference_type: string | null;
  reference_id: string | null;
  operator_name: string;
  created_at: string;
}

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  status: string;
  created_at: string;
  published_at: string | null;
}

const DOMAIN_MATRIX = [
  { code: '01. Core', tables: 'wms_tenants, wms_companies, wms_warehouses, wms_roles, wms_users, wms_configurations', status: 'Active + RLS' },
  { code: '02. Master', tables: 'wms_products, wms_skus, wms_uoms, wms_barcodes, wms_suppliers, wms_customers, wms_carriers', status: 'Active + RLS' },
  { code: '03. Location', tables: 'wms_zones, wms_locations (Aisle/Rack/Shelf/Bin + Pick Sequence)', status: 'Active + RLS' },
  { code: '04. Inbound', tables: 'wms_purchase_orders, wms_dock_appointments, wms_receipts (GRN), wms_qc_inspections, wms_putaway_tasks', status: 'ACID RPC' },
  { code: '05. Inventory', tables: 'wms_inventory_balances, wms_inventory_ledger, wms_lots, wms_serial_numbers, wms_reservations, wms_cycle_counts', status: 'FOR UPDATE Lock' },
  { code: '06. Outbound', tables: 'wms_sales_orders, wms_waves, wms_pick_tasks, wms_box_types, wms_cartons, wms_pack_lines', status: 'FEFO RPC' },
  { code: '07. Replenish', tables: 'wms_replenishment_rules, wms_replenishment_tasks, wms_transfers', status: 'Active + RLS' },
  { code: '08. Transport', tables: 'wms_shipments, wms_posting_records (POD Media)', status: 'ACID Dispatch' },
  { code: '09. Returns', tables: 'wms_returns (RMA Grading & Disposition)', status: 'Active + RLS' },
  { code: '10. Integration', tables: 'wms_integration_endpoints, wms_event_outbox, wms_webhook_inbox, wms_connected_devices', status: 'Transactional Outbox' },
  { code: '11. Audit', tables: 'wms_audit_logs, wms_worker_tasks, wms_operator_stats', status: 'Immutable' },
  { code: '12. Reporting', tables: 'v_wms_kpi_summary, wms_system_metrics, /wms-api?action=metrics', status: 'Prometheus Ready' },
];

export default function CloudMonitor() {
  const { user } = useAuth();
  const [syncState, setSyncState] = useState<SyncSnapshotState>(getSyncState);
  const [edgeHealth, setEdgeHealth] = useState<WmsEdgeHealthResponse | null>(null);
  const [warehouses, setWarehouses] = useState<
    Array<{ id: string; code: string; name: string; city: string; warehouse_type: string; status: string }>
  >([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSyncState(setSyncState);
  }, []);

  const refreshTelemetry = useCallback(async () => {
    setLoading(true);
    try {
      const [health, whList, ledgerRes, outboxRes] = await Promise.all([
        checkEdgeGatewayHealth(syncState.warehouseCode),
        listCloudWarehouses(),
        supabase
          .from('wms_inventory_ledger')
          .select('id, sku_code, transaction_type, qty_delta, balance_before, balance_after, to_location_code, from_location_code, reference_type, reference_id, operator_name, created_at')
          .order('created_at', { ascending: false })
          .limit(25),
        supabase
          .from('wms_event_outbox')
          .select('id, aggregate_type, aggregate_id, event_type, status, created_at, published_at')
          .order('created_at', { ascending: false })
          .limit(20),
      ]);
      setEdgeHealth(health);
      setWarehouses(whList);
      setLedger((ledgerRes.data || []) as LedgerRow[]);
      setOutbox((outboxRes.data || []) as OutboxRow[]);
    } finally {
      setLoading(false);
    }
  }, [syncState.warehouseCode]);

  useEffect(() => {
    void refreshTelemetry();
  }, [refreshTelemetry]);

  const handleManualSync = async () => {
    setLoading(true);
    const drained = await drainLocalOutbox();
    await pullCloudSnapshotToEdge(syncState.warehouseCode);
    await refreshTelemetry();
    setActionBanner(`Synchronized ${syncState.warehouseCode} (${drained.processed} local edge events pushed).`);
    setTimeout(() => setActionBanner(null), 4000);
  };

  const handleFlushOutbox = async () => {
    setLoading(true);
    const res = await flushCloudOutbox();
    await refreshTelemetry();
    setActionBanner(
      res.ok
        ? `Published ${res.published_count} transactional outbox events to downstream webhooks.`
        : 'Could not reach Edge Function outbox publisher.'
    );
    setTimeout(() => setActionBanner(null), 4000);
  };

  const handleSwitchWarehouse = async (code: string) => {
    setLoading(true);
    await setActiveWarehouseCode(code);
    await refreshTelemetry();
    setActionBanner(`Switched active fulfillment warehouse to ${code}.`);
    setTimeout(() => setActionBanner(null), 4000);
  };

  const kpis = edgeHealth?.kpis || syncState.kpis;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Database className="w-6 h-6 text-sky-400" />
            Cloud WMS Core, Security &amp; Telemetry
          </h1>
          <p className="text-xs text-white/50 mt-1">
            12-Domain PostgreSQL Architecture · Supabase Realtime · Edge Function Gateway · Transactional Outbox · Multi-Warehouse Control
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleFlushOutbox}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-xs font-semibold border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 flex items-center gap-1.5 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            Publish Outbox
          </button>
          <button
            type="button"
            onClick={handleManualSync}
            disabled={loading}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-sky-500 text-black hover:bg-sky-400 flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Sync Edge ↔ Cloud
          </button>
        </div>
      </div>

      {actionBanner && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3.5 py-2 text-xs text-sky-200 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0" />
          {actionBanner}
        </div>
      )}

      {/* Top Health & Security Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-panel rounded-xl p-4 border border-white/[0.07]">
          <div className="flex items-center justify-between text-xs text-white/50">
            <span>PostgreSQL Core</span>
            <Database className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-base font-bold text-white">ACTIVE · ACID</span>
          </div>
          <p className="text-[11px] text-white/40 mt-1 truncate font-mono">{SUPABASE_URL.replace('https://', '')}</p>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/[0.07]">
          <div className="flex items-center justify-between text-xs text-white/50">
            <span>Edge API Gateway (`wms-api`)</span>
            <Server className="w-4 h-4 text-sky-400" />
          </div>
          <div className="mt-2 flex items-center gap-2">
            {edgeHealth?.status === 'healthy' ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="text-base font-bold text-white">{edgeHealth.latency_ms} ms</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-base font-bold text-white">{edgeHealth?.status || 'Probing…'}</span>
              </>
            )}
          </div>
          <p className="text-[11px] text-white/40 mt-1">Prometheus `/wms-api?action=metrics`</p>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/[0.07]">
          <div className="flex items-center justify-between text-xs text-white/50">
            <span>Authentication &amp; RLS</span>
            <Lock className="w-4 h-4 text-violet-400" />
          </div>
          <div className="mt-2 text-base font-bold text-white">
            {user?.authMode === 'supabase-pgcrypto' ? 'Bcrypt + RLS' : 'PBKDF2 Edge + RLS'}
          </div>
          <p className="text-[11px] text-white/40 mt-1">
            Tenant: <span className="text-white/70 font-mono">{WMS_TENANT_CODE}</span> · Role: <span className="uppercase text-sky-400">{user?.role}</span>
          </p>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/[0.07]">
          <div className="flex items-center justify-between text-xs text-white/50">
            <span>Hybrid Edge Outbox</span>
            <HardDrive className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 text-base font-bold text-white">
            {syncState.pendingOutbox} Local · {kpis?.outbox_pending ?? 0} Cloud
          </div>
          <p className="text-[11px] text-white/40 mt-1">
            Status: <span className="uppercase text-emerald-400">{syncState.status}</span>
          </p>
        </div>
      </div>

      {/* Multi-Warehouse Switcher & Live Cloud KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="glass-panel rounded-xl p-4 border border-white/[0.07] space-y-3">
          <div className="flex items-center gap-2">
            <Warehouse className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-white">Multi-Warehouse Selector</h2>
          </div>
          <p className="text-[11px] text-white/45">
            Switch active fulfillment center to isolate inventory balances, dock schedules, waves, and ACID ledger entries.
          </p>
          <div className="space-y-2">
            {warehouses.map((wh) => {
              const active = wh.code === syncState.warehouseCode;
              return (
                <button
                  key={wh.id}
                  type="button"
                  onClick={() => handleSwitchWarehouse(wh.code)}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    active
                      ? 'border-sky-400/50 bg-sky-500/10'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-white">{wh.code}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 uppercase">
                      {wh.warehouse_type}
                    </span>
                  </div>
                  <div className="text-xs text-white/75 mt-1">{wh.name}</div>
                  <div className="text-[10px] text-white/40 mt-0.5">{wh.city} · {wh.status}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-2 glass-panel rounded-xl p-4 border border-white/[0.07]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">
                Authoritative PostgreSQL KPI View (`v_wms_kpi_summary` — {syncState.warehouseCode})
              </h2>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Active SKUs', value: kpis?.active_skus ?? 16, color: 'text-white' },
              { label: 'On-Hand Units', value: kpis?.total_on_hand ?? 0, color: 'text-emerald-400' },
              { label: 'Reserved (FEFO)', value: kpis?.total_reserved ?? 0, color: 'text-amber-400' },
              { label: 'Available ATP', value: kpis?.total_available ?? 0, color: 'text-sky-400' },
              { label: 'Open Orders', value: kpis?.open_orders ?? 0, color: 'text-white' },
              { label: 'Shipped Orders', value: kpis?.shipped_orders ?? 0, color: 'text-emerald-400' },
              { label: 'Putaway Queue', value: kpis?.open_putaway_tasks ?? 0, color: 'text-violet-400' },
              { label: 'Active QC Holds', value: kpis?.active_qc_holds ?? 0, color: 'text-rose-400' },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="text-[10px] uppercase tracking-wider text-white/40">{m.label}</div>
                <div className={`text-xl font-bold mt-1 tabular-nums ${m.color}`}>{m.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Live Immutable Inventory Ledger + Transactional Outbox */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-panel rounded-xl border border-white/[0.07] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-semibold text-white flex items-center gap-2">
              <ArrowUpDown className="w-4 h-4 text-sky-400" />
              Immutable Inventory Ledger (`wms_inventory_ledger`)
            </span>
            <span className="text-[10px] text-white/40">{ledger.length} latest ACID entries</span>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[#0c0c10] text-white/45 uppercase text-[9px]">
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left py-2 px-3">SKU</th>
                  <th className="text-left py-2 px-2">Type</th>
                  <th className="text-right py-2 px-2">Delta</th>
                  <th className="text-right py-2 px-2">After</th>
                  <th className="text-left py-2 px-3">Bin</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="py-1.5 px-3 font-mono text-white">{row.sku_code}</td>
                    <td className="py-1.5 px-2 text-white/70">{row.transaction_type}</td>
                    <td className={`py-1.5 px-2 text-right font-mono font-semibold ${row.qty_delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {row.qty_delta >= 0 ? `+${row.qty_delta}` : row.qty_delta}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-white">{row.balance_after}</td>
                    <td className="py-1.5 px-3 font-mono text-white/55">
                      {row.to_location_code || row.from_location_code || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="glass-panel rounded-xl border border-white/[0.07] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-semibold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" />
              Transactional Event Outbox (`wms_event_outbox`)
            </span>
            <span className="text-[10px] text-white/40">{outbox.length} recent events</span>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[#0c0c10] text-white/45 uppercase text-[9px]">
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left py-2 px-3">Event</th>
                  <th className="text-left py-2 px-2">Aggregate</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-right py-2 px-3">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((ev) => (
                  <tr key={ev.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="py-1.5 px-3 font-mono text-sky-300">{ev.event_type}</td>
                    <td className="py-1.5 px-2 font-mono text-white/80">{ev.aggregate_id}</td>
                    <td className="py-1.5 px-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[9px] uppercase font-semibold ${
                          ev.status === 'published'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-amber-500/15 text-amber-300'
                        }`}
                      >
                        {ev.status}
                      </span>
                    </td>
                    <td className="py-1.5 px-3 text-right text-white/45 font-mono text-[10px]">
                      {new Date(ev.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 12-Domain Architecture Matrix */}
      <div className="glass-panel rounded-xl p-4 border border-white/[0.07]">
        <div className="flex items-center gap-2 mb-3">
          <Layers className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-white">12-Domain Fulfillment WMS Schema Blueprint</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {DOMAIN_MATRIX.map((d) => (
            <motion.div
              key={d.code}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">{d.code}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-2.5 h-2.5" />
                  {d.status}
                </span>
              </div>
              <p className="text-[10px] text-white/50 mt-1.5 font-mono leading-relaxed">{d.tables}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
