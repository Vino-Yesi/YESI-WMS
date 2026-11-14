/**
 * YESI-WMS Hybrid Cloud + Edge Transactional Sync Engine (Phase 5 Architecture)
 *
 * Coordinates bidirectional synchronization between:
 *  1. Supabase PostgreSQL 12-Domain Core Database (ACID RPCs + Realtime)
 *  2. Local Warehouse Edge IndexedDB (Dexie) for sub-10ms RF/handheld offline floor ops
 *
 * Uses idempotency keys (`idempotency_key`) and a local Outbox queue stored in
 * Dexie preferences (`wms_sync_outbox_v1`) so zero inventory or dispatch events
 * are lost when warehouse Wi-Fi drops.
 */

import { db } from './db';
import {
  supabase,
  WMS_DEFAULT_WAREHOUSE,
  WMS_TENANT_CODE,
  isSupabaseConfigured,
  subscribeWmsRealtime,
  type WmsKpiSummaryRow,
} from './supabase';

export interface OutboxSyncItem {
  id: string;
  createdAt: string;
  op: 'stock_movement' | 'inbound_grn' | 'allocate_order' | 'dispatch_order' | 'audit_log';
  payload: Record<string, unknown>;
  retries: number;
  lastError?: string;
}

export interface SyncSnapshotState {
  status: 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
  warehouseCode: string;
  lastSyncAt: string | null;
  pendingOutbox: number;
  cloudLatencyMs: number | null;
  lastError: string | null;
  kpis: WmsKpiSummaryRow | null;
}

const OUTBOX_PREF_KEY = 'wms_sync_outbox_v1';
const WAREHOUSE_PREF_KEY = 'wms_active_warehouse_code';

let currentState: SyncSnapshotState = {
  status: 'idle',
  warehouseCode: WMS_DEFAULT_WAREHOUSE,
  lastSyncAt: null,
  pendingOutbox: 0,
  cloudLatencyMs: null,
  lastError: null,
  kpis: null,
};

const listeners = new Set<(state: SyncSnapshotState) => void>();

function emitState(patch: Partial<SyncSnapshotState>) {
  currentState = { ...currentState, ...patch };
  for (const fn of listeners) {
    fn(currentState);
  }
}

export function getSyncState(): SyncSnapshotState {
  return currentState;
}

export function subscribeSyncState(listener: (state: SyncSnapshotState) => void): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export async function getActiveWarehouseCode(): Promise<string> {
  try {
    const pref = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
    if (pref?.value) {
      currentState.warehouseCode = pref.value;
      return pref.value;
    }
  } catch {
    // ignore
  }
  return currentState.warehouseCode || WMS_DEFAULT_WAREHOUSE;
}

export async function setActiveWarehouseCode(code: string): Promise<void> {
  const clean = code.trim() || WMS_DEFAULT_WAREHOUSE;
  const existing = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: clean, createdAt: new Date().toISOString() });
  } else {
    await db.preferences.add({ key: WAREHOUSE_PREF_KEY, value: clean, createdAt: new Date().toISOString() });
  }
  emitState({ warehouseCode: clean });
  await pullCloudSnapshotToEdge(clean);
}

async function readLocalOutbox(): Promise<OutboxSyncItem[]> {
  try {
    const pref = await db.preferences.where('key').equals(OUTBOX_PREF_KEY).first();
    if (!pref?.value) return [];
    const parsed = JSON.parse(pref.value);
    return Array.isArray(parsed) ? (parsed as OutboxSyncItem[]) : [];
  } catch {
    return [];
  }
}

async function writeLocalOutbox(items: OutboxSyncItem[]): Promise<void> {
  const serialized = JSON.stringify(items.slice(-500));
  const existing = await db.preferences.where('key').equals(OUTBOX_PREF_KEY).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: serialized, createdAt: new Date().toISOString() });
  } else {
    await db.preferences.add({ key: OUTBOX_PREF_KEY, value: serialized, createdAt: new Date().toISOString() });
  }
  emitState({ pendingOutbox: items.length });
}

export async function enqueueCloudOperation(
  op: OutboxSyncItem['op'],
  payload: Record<string, unknown>
): Promise<void> {
  const queue = await readLocalOutbox();
  const item: OutboxSyncItem = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    op,
    payload,
    retries: 0,
  };
  queue.push(item);
  await writeLocalOutbox(queue);

  if (typeof navigator === 'undefined' || navigator.onLine) {
    void drainLocalOutbox();
  }
}

async function executeOutboxItem(item: OutboxSyncItem, warehouseCode: string): Promise<void> {
  const p = item.payload;
  switch (item.op) {
    case 'stock_movement': {
      const { error } = await supabase.rpc('wms_record_stock_movement', {
        p_sku_code: String(p.sku || ''),
        p_qty_delta: Number(p.qtyDelta || 0),
        p_transaction_type: String(p.transactionType || 'adjustment'),
        p_location_code: String(p.location || 'PHONE-A-01'),
        p_lot_number: String(p.lotNumber || 'DEFAULT'),
        p_reference_type: p.referenceType ? String(p.referenceType) : null,
        p_reference_id: p.referenceId ? String(p.referenceId) : null,
        p_operator: String(p.operator || 'System'),
        p_note: p.note ? String(p.note) : null,
        p_idempotency_key: item.id,
        p_warehouse_code: warehouseCode,
      });
      if (error) throw new Error(error.message);
      break;
    }
    case 'inbound_grn': {
      const { error } = await supabase.rpc('wms_receive_inbound_grn', {
        p_sku_code: String(p.sku || ''),
        p_qty: Number(p.qty || 1),
        p_description: p.description ? String(p.description) : null,
        p_po_number: p.poNumber ? String(p.poNumber) : null,
        p_supplier_name: String(p.supplier || 'Direct Supplier'),
        p_receiving_bin: String(p.bin || 'RECV-DOCK-01'),
        p_lot_number: String(p.lotNumber || 'DEFAULT'),
        p_qc_status: String(p.qcStatus || 'passed'),
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: warehouseCode,
      });
      if (error) throw new Error(error.message);
      break;
    }
    case 'allocate_order': {
      const { error } = await supabase.rpc('wms_allocate_order_fefo', {
        p_order_number: String(p.orderId || ''),
        p_operator: String(p.operator || 'System'),
        p_warehouse_code: warehouseCode,
      });
      if (error) throw new Error(error.message);
      break;
    }
    case 'dispatch_order': {
      const { error } = await supabase.rpc('wms_dispatch_order', {
        p_order_number: String(p.orderId || ''),
        p_carrier_name: String(p.carrier || 'GBS Express'),
        p_tracking_number: p.trackingNumber ? String(p.trackingNumber) : null,
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: warehouseCode,
      });
      if (error) throw new Error(error.message);
      break;
    }
    case 'audit_log': {
      const { data: wh } = await supabase
        .from('wms_warehouses')
        .select('id, tenant_id')
        .eq('code', warehouseCode)
        .maybeSingle();
      if (wh) {
        const { error } = await supabase.from('wms_audit_logs').insert({
          tenant_id: wh.tenant_id,
          warehouse_id: wh.id,
          operator_name: String(p.operator || 'System'),
          action: String(p.action || 'EVENT'),
          details: String(p.details || ''),
        });
        if (error) throw new Error(error.message);
      }
      break;
    }
  }
}

let isDraining = false;

export async function drainLocalOutbox(): Promise<{ processed: number; remaining: number }> {
  if (!isSupabaseConfigured || isDraining) {
    const q = await readLocalOutbox();
    return { processed: 0, remaining: q.length };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const q = await readLocalOutbox();
    emitState({ status: 'offline', pendingOutbox: q.length });
    return { processed: 0, remaining: q.length };
  }

  isDraining = true;
  const warehouseCode = await getActiveWarehouseCode();
  const queue = await readLocalOutbox();
  if (queue.length === 0) {
    isDraining = false;
    return { processed: 0, remaining: 0 };
  }

  emitState({ status: 'syncing', pendingOutbox: queue.length });
  const remaining: OutboxSyncItem[] = [];
  let processed = 0;

  for (const item of queue) {
    try {
      await executeOutboxItem(item, warehouseCode);
      processed++;
    } catch (err) {
      const retries = item.retries + 1;
      if (retries <= 5) {
        remaining.push({
          ...item,
          retries,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await writeLocalOutbox(remaining);
  isDraining = false;
  emitState({
    status: remaining.length > 0 ? 'error' : 'synced',
    pendingOutbox: remaining.length,
    lastSyncAt: new Date().toISOString(),
    lastError: remaining[0]?.lastError || null,
  });

  return { processed, remaining: remaining.length };
}

/**
 * Pulls authoritative cloud master data, inventory balances, zones, POs, dock
 * appointments, and KPI summaries from Supabase PostgreSQL into local IndexedDB.
 */
export async function pullCloudSnapshotToEdge(explicitWarehouse?: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    emitState({ status: 'offline' });
    return false;
  }

  const started = performance.now();
  const warehouseCode = explicitWarehouse || (await getActiveWarehouseCode());
  emitState({ status: 'syncing', warehouseCode });

  try {
    // Drain pending local mutations first so cloud reflects latest floor scans
    await drainLocalOutbox();

    const { data: wh, error: whErr } = await supabase
      .from('wms_warehouses')
      .select('id, tenant_id, code, name')
      .eq('code', warehouseCode)
      .maybeSingle();

    if (whErr || !wh) {
      throw new Error(whErr?.message || `Warehouse ${warehouseCode} not found in Supabase`);
    }

    const [
      skusRes,
      balancesRes,
      zonesRes,
      ordersRes,
      posRes,
      docksRes,
      putawayRes,
      qcRes,
      kpiRes,
    ] = await Promise.all([
      supabase.from('wms_skus').select('*').eq('tenant_id', wh.tenant_id).eq('is_active', true),
      supabase.from('wms_inventory_balances').select('*').eq('warehouse_id', wh.id),
      supabase.from('wms_zones').select('*').eq('warehouse_id', wh.id),
      supabase.from('wms_sales_orders').select('*').eq('warehouse_id', wh.id).limit(200),
      supabase.from('wms_purchase_orders').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_dock_appointments').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_putaway_tasks').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('wms_qc_inspections').select('*').eq('warehouse_id', wh.id).limit(100),
      supabase.from('v_wms_kpi_summary').select('*').eq('warehouse_code', warehouseCode).maybeSingle(),
    ]);

    const nowIso = new Date().toISOString();

    // 1. Reconcile SKUs + Inventory Balances into local Dexie inventory
    if (skusRes.data && skusRes.data.length > 0) {
      const balanceBySku = new Map<string, { qty: number; location: string; lot: string }>();
      for (const b of balancesRes.data || []) {
        const prev = balanceBySku.get(b.sku_code);
        balanceBySku.set(b.sku_code, {
          qty: (prev?.qty || 0) + Number(b.on_hand_qty || 0),
          location: b.location_code || prev?.location || 'PHONE-A-01',
          lot: b.lot_number || prev?.lot || 'DEFAULT',
        });
      }

      for (const s of skusRes.data) {
        const bal = balanceBySku.get(s.sku_code);
        const existing = await db.inventory.where('sku').equals(s.sku_code).first();
        const payload = {
          sku: s.sku_code,
          product: s.name,
          stock: bal ? bal.qty : existing?.stock ?? 0,
          location: bal?.location || s.default_location_code || existing?.location || 'PHONE-A-01',
          category: s.category || 'General',
          velocity: (s.velocity_class || 'medium') as 'high' | 'medium' | 'low',
          weight: Number(s.weight_kg || 0.4),
          reorderPoint: Number(s.reorder_point ?? 5),
          reorderQty: Number(s.reorder_qty ?? 15),
          barcode: s.primary_barcode || existing?.barcode,
          costPerUnit: Number(s.unit_price || s.unit_cost || 0),
          lotNumber: bal?.lot || existing?.lotNumber,
          serializable: Boolean(s.serializable),
          fefoPriority: Number(s.fefo_priority ?? 50),
          updatedAt: s.updated_at || nowIso,
        };
        if (existing?.id != null) {
          await db.inventory.update(existing.id, payload);
        } else {
          await db.inventory.add(payload);
        }
      }
    }

    // 2. Reconcile Zones
    if (zonesRes.data && zonesRes.data.length > 0) {
      for (const z of zonesRes.data) {
        const existing = await db.zoneCapacities.where('zone').equals(z.zone_code).first();
        const zPayload = {
          zone: z.zone_code,
          maxCapacity: Number(z.max_capacity || 200),
          currentUtilization: Number(z.current_utilization || 0),
          category: z.category_target || 'General',
          velocityTarget: (z.velocity_target || 'high') as 'high' | 'medium' | 'low',
        };
        if (existing?.id != null) {
          await db.zoneCapacities.update(existing.id, zPayload);
        } else {
          await db.zoneCapacities.add(zPayload);
        }
      }
    }

    // 3. Reconcile Cloud Sales Orders (non-destructive merge by orderId)
    if (ordersRes.data && ordersRes.data.length > 0) {
      for (const o of ordersRes.data) {
        const existing = await db.orders.where('orderId').equals(o.order_number).first();
        const mappedStatus =
          o.status === 'Allocated' || o.status === 'Delivered'
            ? (o.status === 'Delivered' ? 'Shipped' : 'ReadyToShip')
            : o.status;
        if (existing?.id != null) {
          await db.orders.update(existing.id, {
            status: mappedStatus,
            priority: o.priority || existing.priority,
            carrier: o.carrier_name || existing.carrier,
            trackingNumber: o.tracking_number || existing.trackingNumber,
            updatedAt: o.updated_at || nowIso,
          });
        } else {
          await db.orders.add({
            orderId: o.order_number,
            status: mappedStatus,
            requiredSkus: o.required_skus,
            priority: o.priority || 'normal',
            createdAt: o.created_at || nowIso,
            updatedAt: o.updated_at || nowIso,
            carrier: o.carrier_name || 'GBS Express',
            service: o.service_level || 'Ozon Global',
            trackingNumber: o.tracking_number || o.order_number,
          });
        }
      }
    }

    // 4. Reconcile Purchase Orders
    if (posRes.data && posRes.data.length > 0) {
      for (const po of posRes.data) {
        const existing = await db.purchaseOrders.where('poNumber').equals(po.po_number).first();
        const poPayload = {
          poNumber: po.po_number,
          supplier: po.supplier_name,
          status: (po.status === 'draft' || po.status === 'asn_received' ? 'open' : po.status) as
            | 'open'
            | 'partial'
            | 'received'
            | 'closed'
            | 'cancelled',
          expectedDelivery: po.expected_delivery || nowIso.slice(0, 10),
          items: JSON.stringify(po.lines || []),
          totalValue: Number(po.total_value || 0),
          currency: po.currency || 'USD',
          notes: po.notes || undefined,
          createdAt: po.created_at || nowIso,
          updatedAt: po.updated_at || nowIso,
        };
        if (existing?.id != null) {
          await db.purchaseOrders.update(existing.id, poPayload);
        } else {
          await db.purchaseOrders.add(poPayload);
        }
      }
    }

    // 5. Reconcile Dock Appointments
    if (docksRes.data && docksRes.data.length > 0) {
      for (const d of docksRes.data) {
        const existing = await db.dockAppointments.where('appointmentId').equals(d.appointment_number).first();
        const dPayload = {
          appointmentId: d.appointment_number,
          supplier: d.supplier_name,
          poNumber: d.po_number || undefined,
          dockNumber: d.dock_door || 'DOCK-01',
          scheduledDate: d.scheduled_date,
          scheduledTime: d.scheduled_time || '09:00',
          estimatedDuration: Number(d.estimated_duration_min || 60),
          status: d.status,
          carrier: d.carrier_name || undefined,
          palletCount: Number(d.pallet_count || 1),
          asnNumber: d.asn_number || undefined,
          operator: d.operator_name || 'System',
          createdAt: d.created_at || nowIso,
        };
        if (existing?.id != null) {
          await db.dockAppointments.update(existing.id, dPayload);
        } else {
          await db.dockAppointments.add(dPayload);
        }
      }
    }

    // 6. Reconcile Putaway Tasks
    if (putawayRes.data && putawayRes.data.length > 0) {
      for (const pt of putawayRes.data) {
        const existing = await db.putawayTasks.where('taskId').equals(pt.task_number).first();
        if (!existing) {
          await db.putawayTasks.add({
            taskId: pt.task_number,
            sku: pt.sku_code,
            product: pt.product_name,
            quantity: Number(pt.quantity || 1),
            lotNumber: pt.lot_number || undefined,
            sourceLocation: pt.source_location || 'RECV-DOCK-01',
            sourceType: pt.source_type || 'receiving',
            suggestedLocation: pt.suggested_location,
            actualLocation: pt.actual_location || undefined,
            destinationZone: pt.destination_zone,
            status: pt.status,
            priority: pt.priority || 'normal',
            createdAt: pt.created_at || nowIso,
            qcStatus: pt.qc_status || 'passed',
            putawayMethod: pt.putaway_method || 'direct',
            operator: pt.operator_name || 'System',
          });
        }
      }
    }

    // 7. Reconcile QC Holds
    if (qcRes.data && qcRes.data.length > 0 && (await db.qcHolds.count()) === 0) {
      for (const q of qcRes.data) {
        await db.qcHolds.add({
          sku: q.sku_code,
          lotNumber: q.lot_number || undefined,
          quantity: Number(q.quantity || 1),
          reason: q.reason,
          status: q.status === 'scrapped' ? 'rejected' : q.status,
          operator: q.inspector_name || 'System',
          createdAt: q.created_at || nowIso,
          releasedAt: q.released_at || undefined,
        });
      }
    }

    const latency = Math.round(performance.now() - started);
    const outbox = await readLocalOutbox();
    emitState({
      status: 'synced',
      warehouseCode,
      lastSyncAt: nowIso,
      pendingOutbox: outbox.length,
      cloudLatencyMs: latency,
      lastError: null,
      kpis: (kpiRes.data as WmsKpiSummaryRow | null) || null,
    });
    return true;
  } catch (err) {
    const outbox = await readLocalOutbox();
    emitState({
      status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      pendingOutbox: outbox.length,
      lastError: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

let engineStarted = false;

export function startHybridSyncEngine(): () => void {
  if (engineStarted) return () => {};
  engineStarted = true;

  void getActiveWarehouseCode().then((wh) => pullCloudSnapshotToEdge(wh));

  const unsubRealtime = subscribeWmsRealtime(() => {
    void pullCloudSnapshotToEdge();
  });

  const handleOnline = () => {
    void drainLocalOutbox().then(() => pullCloudSnapshotToEdge());
  };
  const handleOffline = () => {
    emitState({ status: 'offline' });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }

  const timer = setInterval(() => {
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void drainLocalOutbox();
    }
  }, 30_000);

  return () => {
    engineStarted = false;
    unsubRealtime();
    clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    }
  };
}

export async function listCloudWarehouses(): Promise<
  Array<{ id: string; code: string; name: string; city: string; warehouse_type: string; status: string }>
> {
  try {
    const { data: tenant } = await supabase
      .from('wms_tenants')
      .select('id')
      .eq('code', WMS_TENANT_CODE)
      .maybeSingle();
    if (!tenant) return [];
    const { data } = await supabase
      .from('wms_warehouses')
      .select('id, code, name, city, warehouse_type, status')
      .eq('tenant_id', tenant.id)
      .order('is_default', { ascending: false });
    return (data || []) as Array<{
      id: string;
      code: string;
      name: string;
      city: string;
      warehouse_type: string;
      status: string;
    }>;
  } catch {
    return [];
  }
}
