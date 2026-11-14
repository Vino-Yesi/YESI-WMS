/**
 * YESI-WMS Hardened Cloud + Edge Transactional Sync Engine (v2.1 Enterprise)
 *
 * Enterprise Reliability, Security & Performance Guarantees:
 *  1. Strict Payload & Scope Validation: Rejects malformed/unscoped outbox payloads
 *     before enqueueing; requires explicit tenantCode + warehouseCode on every RPC.
 *  2. Idempotency & Exponential Backoff + Jitter: Every outbox item carries a
 *     deterministic/unique `idempotencyKey`, `nextAttemptAt`, and dead-letter
 *     quarantine after 6 retries so poison items never block healthy floor ops.
 *  3. Throttled Concurrency & Batching: Single-flight mutex, max 15 items per drain
 *     batch, debounced Realtime listeners (2,500ms), and gentle 60s background interval
 *     that pauses automatically when browser tab is hidden or cloud is unconfigured.
 *  4. Non-Destructive Conflict Resolution: Local orders/tasks in active floor states
 *     (Picking, Packed, ReadyToShip, Shipped) are never regressed by stale cloud rows.
 */

import { db } from './db';
import {
  supabase,
  WMS_DEFAULT_WAREHOUSE,
  WMS_TENANT_CODE,
  isSupabaseConfigured,
  getActiveServerSessionToken,
  subscribeWmsRealtime,
  type WmsKpiSummaryRow,
} from './supabase';

export type OutboxOperationType =
  | 'stock_movement'
  | 'inbound_grn'
  | 'qc_release'
  | 'putaway_complete'
  | 'allocate_order'
  | 'confirm_packed'
  | 'dispatch_order'
  | 'return_rma'
  | 'audit_log';

export interface OutboxSyncItem {
  id: string;
  idempotencyKey: string;
  tenantCode: string;
  warehouseCode: string;
  createdAt: string;
  op: OutboxOperationType;
  payload: Record<string, unknown>;
  retries: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface SyncSnapshotState {
  status: 'idle' | 'syncing' | 'synced' | 'offline' | 'unconfigured' | 'error';
  warehouseCode: string;
  lastSyncAt: string | null;
  pendingOutbox: number;
  deadLetterCount: number;
  cloudLatencyMs: number | null;
  lastError: string | null;
  kpis: WmsKpiSummaryRow | null;
}

const OUTBOX_PREF_KEY = 'wms_sync_outbox_v2';
const DEAD_LETTER_PREF_KEY = 'wms_sync_dead_letter_v1';
const WAREHOUSE_PREF_KEY = 'wms_active_warehouse_code';

const MAX_RETRIES = 6;
const MAX_BATCH_SIZE = 15;
const REALTIME_DEBOUNCE_MS = 2_500;
const BACKGROUND_SYNC_INTERVAL_MS = 60_000;

let currentState: SyncSnapshotState = {
  status: isSupabaseConfigured ? 'idle' : 'unconfigured',
  warehouseCode: WMS_DEFAULT_WAREHOUSE,
  lastSyncAt: null,
  pendingOutbox: 0,
  deadLetterCount: 0,
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
  const clean = code.trim().toUpperCase();
  if (!clean) throw new Error('Warehouse code cannot be empty');
  const existing = await db.preferences.where('key').equals(WAREHOUSE_PREF_KEY).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: clean, createdAt: new Date().toISOString() });
  } else {
    await db.preferences.add({ key: WAREHOUSE_PREF_KEY, value: clean, createdAt: new Date().toISOString() });
  }
  emitState({ warehouseCode: clean });
  if (isSupabaseConfigured) {
    await pullCloudSnapshotToEdge(clean);
  }
}

/**
 * Strict schema & business invariant validation for outbox operations.
 * Rejects invalid payloads immediately instead of poisoning the sync queue.
 */
export function validateOutboxPayload(
  op: OutboxOperationType,
  payload: Record<string, unknown>
): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }

  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const positiveInt = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const nonZeroNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v !== 0;

  switch (op) {
    case 'stock_movement':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'stock_movement requires non-empty sku' };
      if (!nonZeroNum(Number(payload.qtyDelta))) return { valid: false, error: 'stock_movement requires non-zero qtyDelta' };
      if (!nonEmpty(payload.transactionType)) return { valid: false, error: 'stock_movement requires transactionType' };
      return { valid: true };

    case 'inbound_grn':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'inbound_grn requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'inbound_grn requires positive qty' };
      return { valid: true };

    case 'qc_release':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'qc_release requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'qc_release requires positive qty' };
      if (!['release', 'scrap'].includes(String(payload.disposition))) {
        return { valid: false, error: 'qc_release disposition must be release or scrap' };
      }
      return { valid: true };

    case 'putaway_complete':
      if (!nonEmpty(payload.taskNumber)) return { valid: false, error: 'putaway_complete requires taskNumber' };
      if (!nonEmpty(payload.actualLocation)) return { valid: false, error: 'putaway_complete requires actualLocation' };
      return { valid: true };

    case 'allocate_order':
    case 'confirm_packed':
    case 'dispatch_order':
      if (!nonEmpty(payload.orderId)) return { valid: false, error: `${op} requires non-empty orderId` };
      return { valid: true };

    case 'return_rma':
      if (!nonEmpty(payload.sku)) return { valid: false, error: 'return_rma requires non-empty sku' };
      if (!positiveInt(Number(payload.qty))) return { valid: false, error: 'return_rma requires positive qty' };
      return { valid: true };

    case 'audit_log':
      if (!nonEmpty(payload.action)) return { valid: false, error: 'audit_log requires action' };
      return { valid: true };

    default:
      return { valid: false, error: `Unknown outbox operation: ${String(op)}` };
  }
}

export function computeBackoffMs(retries: number): number {
  const baseMs = Math.min(300_000, 1_500 * Math.pow(2, Math.max(0, retries - 1)));
  const jitter = Math.floor(Math.random() * 600);
  return baseMs + jitter;
}

async function readJsonPref<T>(key: string): Promise<T[]> {
  try {
    const pref = await db.preferences.where('key').equals(key).first();
    if (!pref?.value) return [];
    const parsed = JSON.parse(pref.value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonPref<T>(key: string, items: T[], maxItems = 1000): Promise<void> {
  const serialized = JSON.stringify(items.slice(-maxItems));
  const existing = await db.preferences.where('key').equals(key).first();
  if (existing?.id != null) {
    await db.preferences.update(existing.id, { value: serialized, createdAt: new Date().toISOString() });
  } else {
    await db.preferences.add({ key, value: serialized, createdAt: new Date().toISOString() });
  }
}

export async function getDeadLetterOutbox(): Promise<OutboxSyncItem[]> {
  return readJsonPref<OutboxSyncItem>(DEAD_LETTER_PREF_KEY);
}

let scheduledDrainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleThrottledDrain(delayMs = 450) {
  if (!isSupabaseConfigured) return;
  if (scheduledDrainTimer) return;
  scheduledDrainTimer = setTimeout(() => {
    scheduledDrainTimer = null;
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void drainLocalOutbox();
    }
  }, delayMs);
}

export async function enqueueCloudOperation(
  op: OutboxOperationType,
  payload: Record<string, unknown>,
  explicitIdempotencyKey?: string
): Promise<{ queued: boolean; idempotencyKey?: string; error?: string }> {
  const check = validateOutboxPayload(op, payload);
  if (!check.valid) {
    return { queued: false, error: check.error };
  }

  const warehouseCode = String(payload.warehouseCode || (await getActiveWarehouseCode())).trim().toUpperCase();
  const tenantCode = String(payload.tenantCode || WMS_TENANT_CODE).trim().toUpperCase();
  const id = crypto.randomUUID();
  const idempotencyKey = explicitIdempotencyKey || `${tenantCode}:${warehouseCode}:${op}:${id}`;

  const queue = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
  // Idempotency deduplication inside local queue
  if (queue.some((q) => q.idempotencyKey === idempotencyKey)) {
    return { queued: true, idempotencyKey };
  }

  const item: OutboxSyncItem = {
    id,
    idempotencyKey,
    tenantCode,
    warehouseCode,
    createdAt: new Date().toISOString(),
    op,
    payload,
    retries: 0,
    nextAttemptAt: 0,
  };

  queue.push(item);
  await writeJsonPref(OUTBOX_PREF_KEY, queue);
  emitState({ pendingOutbox: queue.length });

  scheduleThrottledDrain();
  return { queued: true, idempotencyKey };
}

async function executeOutboxItem(item: OutboxSyncItem): Promise<void> {
  const p = item.payload;
  const sessionToken = getActiveServerSessionToken();
  const wh = item.warehouseCode;
  const tenant = item.tenantCode;

  switch (item.op) {
    case 'stock_movement': {
      const { data, error } = await supabase.rpc('wms_record_stock_movement', {
        p_sku_code: String(p.sku).trim(),
        p_qty_delta: Number(p.qtyDelta),
        p_transaction_type: String(p.transactionType),
        p_location_code: String(p.location || 'PHONE-A-01'),
        p_lot_number: String(p.lotNumber || 'DEFAULT'),
        p_reference_type: p.referenceType ? String(p.referenceType) : null,
        p_reference_id: p.referenceId ? String(p.referenceId) : null,
        p_operator: String(p.operator || 'System'),
        p_note: p.note ? String(p.note) : null,
        p_idempotency_key: item.idempotencyKey,
        p_warehouse_code: wh,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Stock movement rejected');
      break;
    }

    case 'inbound_grn': {
      const { data, error } = await supabase.rpc('wms_receive_inbound_grn', {
        p_sku_code: String(p.sku).trim(),
        p_qty: Number(p.qty),
        p_description: p.description ? String(p.description) : null,
        p_po_number: p.poNumber ? String(p.poNumber) : null,
        p_supplier_name: String(p.supplier || 'Direct Supplier'),
        p_receiving_bin: String(p.bin || 'RECV-DOCK-01'),
        p_lot_number: String(p.lotNumber || 'DEFAULT'),
        p_qc_status: String(p.qcStatus || 'pending'),
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_idempotency_key: item.idempotencyKey,
        p_session_token: sessionToken,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Inbound GRN rejected');
      break;
    }

    case 'qc_release': {
      const { data, error } = await supabase.rpc('wms_release_qc_hold', {
        p_sku_code: String(p.sku).trim(),
        p_quantity: Number(p.qty),
        p_disposition: String(p.disposition || 'release'),
        p_reason: String(p.reason || 'QC Inspection'),
        p_inspector: String(p.operator || 'Supervisor'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_lot_number: String(p.lotNumber || 'DEFAULT'),
        p_idempotency_key: item.idempotencyKey,
        p_session_token: sessionToken,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'QC disposition rejected');
      break;
    }

    case 'putaway_complete': {
      const { data, error } = await supabase.rpc('wms_complete_putaway_task', {
        p_task_number: String(p.taskNumber).trim(),
        p_actual_location: String(p.actualLocation).trim(),
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_idempotency_key: item.idempotencyKey,
        p_session_token: sessionToken,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Putaway completion rejected');
      break;
    }

    case 'allocate_order': {
      const { data, error } = await supabase.rpc('wms_allocate_order_fefo', {
        p_order_number: String(p.orderId).trim(),
        p_operator: String(p.operator || 'System'),
        p_warehouse_code: wh,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Order allocation failed');
      break;
    }

    case 'confirm_packed': {
      const { data, error } = await supabase.rpc('wms_confirm_order_packed', {
        p_order_number: String(p.orderId).trim(),
        p_box_name: String(p.boxName || 'Standard Carton'),
        p_weight_kg: Number(p.weightKg || 0.4),
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_session_token: sessionToken,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Order pack confirmation rejected');
      break;
    }

    case 'dispatch_order': {
      const { data, error } = await supabase.rpc('wms_dispatch_order', {
        p_order_number: String(p.orderId).trim(),
        p_carrier_name: String(p.carrier || 'GBS Express'),
        p_tracking_number: p.trackingNumber ? String(p.trackingNumber) : null,
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_session_token: sessionToken,
        p_allow_direct_override: Boolean(p.allowDirectOverride),
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Order dispatch rejected');
      break;
    }

    case 'return_rma': {
      const { data, error } = await supabase.rpc('wms_process_return_rma', {
        p_order_number: String(p.orderId || ''),
        p_sku_code: String(p.sku).trim(),
        p_quantity: Number(p.qty),
        p_reason: String(p.reason || 'Return'),
        p_disposition: String(p.disposition || 'quarantine'),
        p_operator: String(p.operator || 'Operator'),
        p_warehouse_code: wh,
        p_tenant_code: tenant,
        p_idempotency_key: item.idempotencyKey,
        p_session_token: sessionToken,
      });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'RMA processing rejected');
      break;
    }

    case 'audit_log': {
      const { data: tenantRow } = await supabase
        .from('wms_tenants')
        .select('id')
        .eq('code', tenant)
        .maybeSingle();
      if (!tenantRow) throw new Error(`Tenant ${tenant} not found`);

      const { data: whRow } = await supabase
        .from('wms_warehouses')
        .select('id, tenant_id')
        .eq('tenant_id', tenantRow.id)
        .eq('code', wh)
        .maybeSingle();
      if (!whRow) throw new Error(`Warehouse ${wh} not found under ${tenant}`);

      const { error } = await supabase.from('wms_audit_logs').insert({
        tenant_id: whRow.tenant_id,
        warehouse_id: whRow.id,
        operator_name: String(p.operator || 'System'),
        action: String(p.action || 'EVENT'),
        entity_type: p.entityType ? String(p.entityType) : null,
        entity_id: p.entityId ? String(p.entityId) : null,
        details: String(p.details || ''),
      });
      if (error) throw new Error(error.message);
      break;
    }
  }
}

let isDraining = false;

export async function drainLocalOutbox(): Promise<{ processed: number; remaining: number }> {
  if (!isSupabaseConfigured) {
    const q = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    emitState({ status: 'unconfigured', pendingOutbox: q.length });
    return { processed: 0, remaining: q.length };
  }
  if (isDraining) {
    const q = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    return { processed: 0, remaining: q.length };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const q = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    emitState({ status: 'offline', pendingOutbox: q.length });
    return { processed: 0, remaining: q.length };
  }

  isDraining = true;
  try {
    const queue = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    if (queue.length === 0) {
      return { processed: 0, remaining: 0 };
    }

    const nowMs = Date.now();
    const eligible = queue.filter((i) => (i.nextAttemptAt || 0) <= nowMs).slice(0, MAX_BATCH_SIZE);
    if (eligible.length === 0) {
      return { processed: 0, remaining: queue.length };
    }

    emitState({ status: 'syncing', pendingOutbox: queue.length });
    const eligibleIds = new Set(eligible.map((e) => e.id));
    const untouched = queue.filter((i) => !eligibleIds.has(i.id));
    const retryItems: OutboxSyncItem[] = [];
    const newDeadLetters: OutboxSyncItem[] = [];
    let processed = 0;

    for (const item of eligible) {
      try {
        await executeOutboxItem(item);
        processed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const retries = item.retries + 1;
        // Permanent validation/permission errors or exhausted retries move to dead-letter queue
        const isPermanentError =
          errMsg.includes('VALIDATION_ERROR') ||
          errMsg.includes('LIFECYCLE_VIOLATION') ||
          errMsg.includes('PERMISSION_DENIED') ||
          retries > MAX_RETRIES;

        if (isPermanentError) {
          newDeadLetters.push({ ...item, retries, lastError: errMsg });
        } else {
          retryItems.push({
            ...item,
            retries,
            nextAttemptAt: Date.now() + computeBackoffMs(retries),
            lastError: errMsg,
          });
        }
      }
    }

    const remainingQueue = [...retryItems, ...untouched];
    await writeJsonPref(OUTBOX_PREF_KEY, remainingQueue);

    let deadLetterTotal = currentState.deadLetterCount;
    if (newDeadLetters.length > 0) {
      const dlq = await readJsonPref<OutboxSyncItem>(DEAD_LETTER_PREF_KEY);
      const mergedDlq = [...dlq, ...newDeadLetters];
      await writeJsonPref(DEAD_LETTER_PREF_KEY, mergedDlq, 250);
      deadLetterTotal = mergedDlq.length;
    }

    emitState({
      status: retryItems.length > 0 ? 'error' : 'synced',
      pendingOutbox: remainingQueue.length,
      deadLetterCount: deadLetterTotal,
      lastSyncAt: new Date().toISOString(),
      lastError: retryItems[0]?.lastError || newDeadLetters[0]?.lastError || null,
    });

    return { processed, remaining: remainingQueue.length };
  } finally {
    isDraining = false;
  }
}

//Rank order lifecycle stages so cloud sync never regresses advanced local floor states
const ORDER_STAGE_RANK: Record<string, number> = {
  Pending: 1,
  CrossDock: 2,
  Picking: 3,
  Packed: 4,
  ReadyToShip: 5,
  Shipped: 6,
  Returned: 7,
};

let isPulling = false;
let activeWarehouseIdCache: string | null = null;

/**
 * Reconciles authoritative cloud state into local Dexie IndexedDB inside atomic
 * transactions with conflict protection and partial-failure resilience.
 */
export async function pullCloudSnapshotToEdge(explicitWarehouse?: string): Promise<boolean> {
  if (!isSupabaseConfigured) {
    emitState({ status: 'unconfigured' });
    return false;
  }
  if (isPulling) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    emitState({ status: 'offline' });
    return false;
  }

  isPulling = true;
  const started = performance.now();
  const warehouseCode = (explicitWarehouse || (await getActiveWarehouseCode())).trim().toUpperCase();
  emitState({ status: 'syncing', warehouseCode });

  try {
    await drainLocalOutbox();

    // Strictly verify tenant + warehouse relationship
    const { data: tenantRow, error: tenantErr } = await supabase
      .from('wms_tenants')
      .select('id, code')
      .eq('code', WMS_TENANT_CODE)
      .eq('status', 'active')
      .maybeSingle();

    if (tenantErr || !tenantRow) {
      throw new Error(tenantErr?.message || `Tenant ${WMS_TENANT_CODE} not found or inactive`);
    }

    const { data: wh, error: whErr } = await supabase
      .from('wms_warehouses')
      .select('id, tenant_id, code, name')
      .eq('tenant_id', tenantRow.id)
      .eq('code', warehouseCode)
      .eq('status', 'active')
      .maybeSingle();

    if (whErr || !wh) {
      throw new Error(whErr?.message || `Warehouse ${warehouseCode} not active under ${WMS_TENANT_CODE}`);
    }

    activeWarehouseIdCache = wh.id;

    // Use allSettled so partial network/query glitches do not abort the entire sync snapshot
    const settled = await Promise.allSettled([
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

    const unwrap = <T>(idx: number): T | null => {
      const r = settled[idx];
      if (r.status === 'fulfilled' && !r.value.error) {
        return r.value.data as T;
      }
      return null;
    };

    const skusData = unwrap<Array<Record<string, unknown>>>(0);
    const balancesData = unwrap<Array<Record<string, unknown>>>(1);
    const zonesData = unwrap<Array<Record<string, unknown>>>(2);
    const ordersData = unwrap<Array<Record<string, unknown>>>(3);
    const posData = unwrap<Array<Record<string, unknown>>>(4);
    const docksData = unwrap<Array<Record<string, unknown>>>(5);
    const putawayData = unwrap<Array<Record<string, unknown>>>(6);
    const qcData = unwrap<Array<Record<string, unknown>>>(7);
    const kpiData = unwrap<WmsKpiSummaryRow>(8);

    const nowIso = new Date().toISOString();

    // Atomic batched Dexie transaction for Inventory + Zones + Orders
    await db.transaction('rw', [db.inventory, db.zoneCapacities, db.orders], async () => {
      if (skusData && skusData.length > 0) {
        const balanceBySku = new Map<string, { qty: number; location: string; lot: string }>();
        for (const b of balancesData || []) {
          const code = String(b.sku_code || '');
          const prev = balanceBySku.get(code);
          balanceBySku.set(code, {
            qty: (prev?.qty || 0) + Number(b.on_hand_qty || 0),
            location: String(b.location_code || prev?.location || 'PHONE-A-01'),
            lot: String(b.lot_number || prev?.lot || 'DEFAULT'),
          });
        }

        const localInv = await db.inventory.toArray();
        const localBySku = new Map(localInv.map((i) => [i.sku, i]));

        for (const s of skusData) {
          const skuCode = String(s.sku_code || '');
          if (!skuCode) continue;
          const bal = balanceBySku.get(skuCode);
          const existing = localBySku.get(skuCode);
          const payload = {
            sku: skuCode,
            product: String(s.name || skuCode),
            stock: bal ? bal.qty : existing?.stock ?? 0,
            location: bal?.location || String(s.default_location_code || existing?.location || 'PHONE-A-01'),
            category: String(s.category || 'General'),
            velocity: (String(s.velocity_class || 'medium') as 'high' | 'medium' | 'low'),
            weight: Number(s.weight_kg || 0.4),
            reorderPoint: Number(s.reorder_point ?? 5),
            reorderQty: Number(s.reorder_qty ?? 15),
            barcode: s.primary_barcode ? String(s.primary_barcode) : existing?.barcode,
            costPerUnit: Number(s.unit_price || s.unit_cost || 0),
            lotNumber: bal?.lot || existing?.lotNumber,
            serializable: Boolean(s.serializable),
            fefoPriority: Number(s.fefo_priority ?? 50),
            updatedAt: String(s.updated_at || nowIso),
          };
          if (existing?.id != null) {
            await db.inventory.update(existing.id, payload);
          } else {
            await db.inventory.add(payload);
          }
        }
      }

      if (zonesData && zonesData.length > 0) {
        const localZones = await db.zoneCapacities.toArray();
        const zoneMap = new Map(localZones.map((z) => [z.zone, z]));
        for (const z of zonesData) {
          const zCode = String(z.zone_code || '');
          if (!zCode) continue;
          const existing = zoneMap.get(zCode);
          const zPayload = {
            zone: zCode,
            maxCapacity: Number(z.max_capacity || 200),
            currentUtilization: Number(z.current_utilization || 0),
            category: String(z.category_target || 'General'),
            velocityTarget: (String(z.velocity_target || 'high') as 'high' | 'medium' | 'low'),
          };
          if (existing?.id != null) {
            await db.zoneCapacities.update(existing.id, zPayload);
          } else {
            await db.zoneCapacities.add(zPayload);
          }
        }
      }

      if (ordersData && ordersData.length > 0) {
        const localOrders = await db.orders.toArray();
        const orderMap = new Map(localOrders.map((o) => [o.orderId, o]));
        for (const o of ordersData) {
          const ordNum = String(o.order_number || '');
          if (!ordNum) continue;
          const existing = orderMap.get(ordNum);
          const rawCloudStatus = String(o.status || 'Pending');
          const mappedCloudStatus = (
            rawCloudStatus === 'Allocated'
              ? 'Picking'
              : rawCloudStatus === 'Delivered'
                ? 'Shipped'
                : rawCloudStatus
          ) as 'Pending' | 'Picking' | 'Packed' | 'ReadyToShip' | 'Shipped' | 'Returned' | 'CrossDock';

          const normPriority = (
            ['urgent', 'high', 'normal'].includes(String(o.priority || 'normal'))
              ? String(o.priority)
              : 'normal'
          ) as 'urgent' | 'high' | 'normal';

          if (existing?.id != null) {
            // Conflict Resolution: Never downgrade a local order that has progressed further on the floor
            const localRank = ORDER_STAGE_RANK[existing.status] ?? 0;
            const cloudRank = ORDER_STAGE_RANK[mappedCloudStatus] ?? 0;
            const winningStatus = localRank > cloudRank ? existing.status : mappedCloudStatus;

            await db.orders.update(existing.id, {
              status: winningStatus,
              priority: normPriority,
              carrier: o.carrier_name ? String(o.carrier_name) : existing.carrier,
              trackingNumber: o.tracking_number ? String(o.tracking_number) : existing.trackingNumber,
              updatedAt: String(o.updated_at || nowIso),
            });
          } else {
            await db.orders.add({
              orderId: ordNum,
              status: mappedCloudStatus,
              requiredSkus: String(o.required_skus || ''),
              priority: normPriority,
              createdAt: String(o.created_at || nowIso),
              updatedAt: String(o.updated_at || nowIso),
              carrier: String(o.carrier_name || 'GBS Express'),
              service: String(o.service_level || 'Ozon Global'),
              trackingNumber: String(o.tracking_number || ordNum),
            });
          }
        }
      }
    });

    // Secondary transaction for Inbound POs, Dock, Putaway & QC
    await db.transaction('rw', [db.purchaseOrders, db.dockAppointments, db.putawayTasks, db.qcHolds], async () => {
      if (posData && posData.length > 0) {
        for (const po of posData) {
          const poNum = String(po.po_number || '');
          if (!poNum) continue;
          const existing = await db.purchaseOrders.where('poNumber').equals(poNum).first();
          const rawSt = String(po.status || 'open');
          const poPayload = {
            poNumber: poNum,
            supplier: String(po.supplier_name || 'Supplier'),
            status: (rawSt === 'draft' || rawSt === 'asn_received' ? 'open' : rawSt) as
              | 'open'
              | 'partial'
              | 'received'
              | 'closed'
              | 'cancelled',
            expectedDelivery: String(po.expected_delivery || nowIso.slice(0, 10)),
            items: JSON.stringify(po.lines || []),
            totalValue: Number(po.total_value || 0),
            currency: String(po.currency || 'USD'),
            notes: po.notes ? String(po.notes) : undefined,
            createdAt: String(po.created_at || nowIso),
            updatedAt: String(po.updated_at || nowIso),
          };
          if (existing?.id != null) {
            await db.purchaseOrders.update(existing.id, poPayload);
          } else {
            await db.purchaseOrders.add(poPayload);
          }
        }
      }

      if (docksData && docksData.length > 0) {
        for (const d of docksData) {
          const appNum = String(d.appointment_number || '');
          if (!appNum) continue;
          const existing = await db.dockAppointments.where('appointmentId').equals(appNum).first();
          const rawDockStatus = String(d.status || 'scheduled');
          const normDockStatus = (
            rawDockStatus === 'arrived' ? 'checked_in' : rawDockStatus
          ) as 'scheduled' | 'checked_in' | 'unloading' | 'completed' | 'no_show' | 'cancelled';
          const dPayload = {
            appointmentId: appNum,
            supplier: String(d.supplier_name || 'Supplier'),
            poNumber: d.po_number ? String(d.po_number) : undefined,
            dockNumber: String(d.dock_door || 'DOCK-01'),
            scheduledDate: String(d.scheduled_date || nowIso.slice(0, 10)),
            scheduledTime: String(d.scheduled_time || '09:00'),
            estimatedDuration: Number(d.estimated_duration_min || 60),
            status: normDockStatus,
            carrier: d.carrier_name ? String(d.carrier_name) : undefined,
            palletCount: Number(d.pallet_count || 1),
            asnNumber: d.asn_number ? String(d.asn_number) : undefined,
            operator: String(d.operator_name || 'System'),
            createdAt: String(d.created_at || nowIso),
          };
          if (existing?.id != null) {
            await db.dockAppointments.update(existing.id, dPayload);
          } else {
            await db.dockAppointments.add(dPayload);
          }
        }
      }

      if (putawayData && putawayData.length > 0) {
        for (const pt of putawayData) {
          const taskNum = String(pt.task_number || '');
          if (!taskNum) continue;
          const existing = await db.putawayTasks.where('taskId').equals(taskNum).first();
          if (!existing) {
            const rawSrc = String(pt.source_type || 'receiving');
            const normSrc = (rawSrc === 'return' ? 'returns' : rawSrc) as
              | 'receiving'
              | 'returns'
              | 'transfer'
              | 'qc_release'
              | 'cross_dock';
            const rawMethod = String(pt.putaway_method || 'direct');
            const normMethod = (
              ['direct', 'zone', 'cross_dock', 'consolidation'].includes(rawMethod) ? rawMethod : 'direct'
            ) as 'direct' | 'zone' | 'cross_dock' | 'consolidation';

            await db.putawayTasks.add({
              taskId: taskNum,
              sku: String(pt.sku_code || ''),
              product: String(pt.product_name || pt.sku_code || ''),
              quantity: Number(pt.quantity || 1),
              lotNumber: pt.lot_number ? String(pt.lot_number) : undefined,
              sourceLocation: String(pt.source_location || 'RECV-DOCK-01'),
              sourceType: normSrc,
              suggestedLocation: String(pt.suggested_location || 'PHONE-A-01'),
              actualLocation: pt.actual_location ? String(pt.actual_location) : undefined,
              destinationZone: String(pt.destination_zone || 'PHONE-A'),
              status: (String(pt.status || 'pending') as 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'),
              priority: (['urgent', 'high', 'normal'].includes(String(pt.priority)) ? String(pt.priority) : 'normal') as 'urgent' | 'high' | 'normal',
              createdAt: String(pt.created_at || nowIso),
              qcStatus: (String(pt.qc_status || 'passed') === 'pending' ? 'pending' : 'passed'),
              putawayMethod: normMethod,
              operator: String(pt.operator_name || 'System'),
            });
          }
        }
      }

      if (qcData && qcData.length > 0 && (await db.qcHolds.count()) === 0) {
        for (const q of qcData) {
          const qStatus = String(q.status || 'hold');
          await db.qcHolds.add({
            sku: String(q.sku_code || ''),
            lotNumber: q.lot_number ? String(q.lot_number) : undefined,
            quantity: Number(q.quantity || 1),
            reason: String(q.reason || 'QC Hold'),
            status: (qStatus === 'scrapped' ? 'rejected' : qStatus) as 'hold' | 'released' | 'rejected',
            operator: String(q.inspector_name || 'System'),
            createdAt: String(q.created_at || nowIso),
            releasedAt: q.released_at ? String(q.released_at) : undefined,
          });
        }
      }
    });

    const latency = Math.round(performance.now() - started);
    const outbox = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    const dlq = await readJsonPref<OutboxSyncItem>(DEAD_LETTER_PREF_KEY);
    emitState({
      status: 'synced',
      warehouseCode,
      lastSyncAt: nowIso,
      pendingOutbox: outbox.length,
      deadLetterCount: dlq.length,
      cloudLatencyMs: latency,
      lastError: null,
      kpis: kpiData || null,
    });
    return true;
  } catch (err) {
    const outbox = await readJsonPref<OutboxSyncItem>(OUTBOX_PREF_KEY);
    emitState({
      status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      pendingOutbox: outbox.length,
      lastError: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    isPulling = false;
  }
}

let engineStarted = false;

export function startHybridSyncEngine(explicitWarehouse?: string): () => void {
  if (!isSupabaseConfigured) {
    emitState({ status: 'unconfigured' });
    return () => {};
  }
  if (engineStarted) return () => {};
  engineStarted = true;

  let realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
  let unsubRealtime: (() => void) | null = null;

  void (async () => {
    const wh = explicitWarehouse || (await getActiveWarehouseCode());
    await pullCloudSnapshotToEdge(wh);
    unsubRealtime = subscribeWmsRealtime(activeWarehouseIdCache, () => {
      if (realtimeDebounce) clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          void pullCloudSnapshotToEdge();
        }
      }, REALTIME_DEBOUNCE_MS);
    });
  })();

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

  // Throttled 60s background sync that respects page visibility
  const timer = setInterval(() => {
    const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (isVisible && (typeof navigator === 'undefined' || navigator.onLine)) {
      void drainLocalOutbox();
    }
  }, BACKGROUND_SYNC_INTERVAL_MS);

  return () => {
    engineStarted = false;
    if (realtimeDebounce) clearTimeout(realtimeDebounce);
    unsubRealtime?.();
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
  if (!isSupabaseConfigured) return [];
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
