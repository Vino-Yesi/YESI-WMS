import { db, logAction, logInventoryMovement } from './db';
import { enqueueCloudOperation } from './supabaseSync';
import type { InventoryReservation, Order } from './db';

export type { InventoryReservation };

export interface AllocationResult {
  success: boolean;
  reservations: InventoryReservation[];
  conflicts: string[];
  message: string;
}

/**
 * Atomic Transactional FEFO Allocation
 *
 * Wraps multi-SKU reservation & serial locking inside a single Dexie `rw` transaction.
 * If ANY SKU line in the order lacks sufficient unreserved available stock, zero partial
 * reservations are committed (all-or-nothing atomicity).
 */
export async function allocateOrder(
  order: Order,
  operator: string
): Promise<AllocationResult> {
  const skus = order.requiredSkus.split(',').map((s) => s.trim()).filter(Boolean);
  const counts: Record<string, number> = {};
  for (const sku of skus) counts[sku] = (counts[sku] || 0) + 1;

  const reservations: InventoryReservation[] = [];
  const conflicts: string[] = [];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 3_600_000).toISOString();

  await db.transaction(
    'rw',
    [db.inventory, db.inventoryReservations, db.serialNumbers, db.orders],
    async () => {
      // Phase 1: Validate all lines before mutating
      const stagedLines: Array<{
        sku: string;
        qty: number;
        lotNumber?: string;
        fefoPriority: number;
        serialIds: number[];
        serialCodes: string[];
      }> = [];

      for (const [sku, qty] of Object.entries(counts)) {
        const items = await db.inventory.where('sku').equals(sku).toArray();
        const item = items[0];
        if (!item) {
          conflicts.push(`${sku}: SKU not found`);
          continue;
        }

        const existingReserved = await db.inventoryReservations
          .where('sku')
          .equals(sku)
          .filter((r) => r.status === 'reserved' || r.status === 'allocated')
          .toArray();
        const reservedQty = existingReserved.reduce((s, r) => s + r.quantity, 0);
        const available = (item.stock || 0) - reservedQty;

        if (available < qty) {
          conflicts.push(`${sku}: need ${qty}, only ${available} available (${reservedQty} reserved)`);
          continue;
        }

        const serials = (
          await db.serialNumbers
            .where('sku')
            .equals(sku)
            .filter((s) => s.status === 'in_stock')
            .toArray()
        ).sort((a, b) => (a.expiryDate || '').localeCompare(b.expiryDate || ''));

        const selected = item.serializable || serials.length > 0 ? serials.slice(0, qty) : [];
        stagedLines.push({
          sku,
          qty,
          lotNumber: item.lotNumber,
          fefoPriority: item.fefoPriority || 99,
          serialIds: selected.map((s) => s.id!).filter(Boolean),
          serialCodes: selected.map((s) => s.serialNumber),
        });
      }

      if (conflicts.length > 0) {
        return;
      }

      // Phase 2: Commit reservations + serial locks + order status atomically
      for (const line of stagedLines) {
        const reservation: InventoryReservation = {
          reservationId: `RES-${order.orderId}-${line.sku}-${Date.now()}`,
          orderId: order.orderId,
          sku: line.sku,
          quantity: line.qty,
          lotNumber: line.lotNumber,
          serialNumbers: line.serialCodes.length > 0 ? line.serialCodes.join(',') : undefined,
          status: 'reserved',
          fefoPriority: line.fefoPriority,
          reservedAt: now.toISOString(),
          expiresAt,
          operator,
        };

        for (const sid of line.serialIds) {
          await db.serialNumbers.update(sid, {
            status: 'reserved',
            orderId: order.orderId,
            updatedAt: now.toISOString(),
          });
        }

        await db.inventoryReservations.add(reservation);
        reservations.push(reservation);
      }

      if (order.id != null && order.status === 'Pending') {
        await db.orders.update(order.id, {
          status: 'Picking',
          updatedAt: now.toISOString(),
        });
      }
    }
  );

  const success = conflicts.length === 0;
  if (success) {
    await logAction(
      'ALLOCATE_ORDER',
      `Reserved inventory for ${order.orderId}: ${reservations.map((r) => `${r.sku}×${r.quantity}`).join(', ')}`,
      operator
    );
    void enqueueCloudOperation(
      'allocate_order',
      { orderId: order.orderId, operator },
      `alloc:${order.orderId}`
    );
  }

  return {
    success,
    reservations,
    conflicts,
    message: success
      ? `Allocated ${reservations.length} SKU lines for ${order.orderId}`
      : `Allocation failed: ${conflicts.join('; ')}`,
  };
}

export async function releaseReservation(reservationId: string, operator: string): Promise<boolean> {
  let released = false;
  await db.transaction('rw', [db.inventoryReservations, db.serialNumbers], async () => {
    const res = await db.inventoryReservations.where('reservationId').equals(reservationId).first();
    if (!res || res.status === 'picked' || res.status === 'released') return;

    if (res.serialNumbers) {
      for (const sn of res.serialNumbers.split(',')) {
        const serial = await db.serialNumbers.where('serialNumber').equals(sn.trim()).first();
        if (serial?.id != null) {
          await db.serialNumbers.update(serial.id, {
            status: 'in_stock',
            orderId: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    await db.inventoryReservations.update(res.id!, { status: 'released' });
    released = true;
  });

  if (released) {
    await logAction('RELEASE_RESERVATION', `Released ${reservationId}`, operator);
  }
  return released;
}

export async function fulfillReservation(reservationId: string, operator: string): Promise<boolean> {
  let snap: { sku: string; qty: number; orderId: string; lotNumber?: string } | null = null;

  await db.transaction('rw', [db.inventoryReservations, db.inventory, db.serialNumbers], async () => {
    const res = await db.inventoryReservations.where('reservationId').equals(reservationId).first();
    if (!res || res.status !== 'reserved') return;

    const item = await db.inventory.where('sku').equals(res.sku).first();
    if (!item || (item.stock || 0) < res.quantity) return;

    await db.inventory.update(item.id!, {
      stock: (item.stock || 0) - res.quantity,
      updatedAt: new Date().toISOString(),
    });
    await db.inventoryReservations.update(res.id!, { status: 'picked' });

    if (res.serialNumbers) {
      for (const sn of res.serialNumbers.split(',')) {
        const serial = await db.serialNumbers.where('serialNumber').equals(sn.trim()).first();
        if (serial?.id != null) {
          await db.serialNumbers.update(serial.id, {
            status: 'shipped',
            orderId: res.orderId,
            shippedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    snap = { sku: res.sku, qty: res.quantity, orderId: res.orderId, lotNumber: res.lotNumber };
  });

  if (!snap) return false;
  const s = snap as { sku: string; qty: number; orderId: string; lotNumber?: string };
  await logInventoryMovement(s.sku, 'pick', s.qty, operator, {
    orderId: s.orderId,
    lotNumber: s.lotNumber,
    note: `FEFO allocation ${reservationId}`,
  });
  return true;
}

export async function getAllocationSummary() {
  const [reservations, orders, inventory] = await Promise.all([
    db.inventoryReservations.toArray(),
    db.orders.where('status').equals('Pending').toArray(),
    db.inventory.toArray(),
  ]);

  const active = reservations.filter((r) => r.status === 'reserved' || r.status === 'allocated');
  const reservedBySku: Record<string, number> = {};
  for (const r of active) reservedBySku[r.sku] = (reservedBySku[r.sku] || 0) + r.quantity;

  const allocatedOrderIds = new Set(active.map((r) => r.orderId));
  const pendingAllocations = orders.filter((o) => !allocatedOrderIds.has(o.orderId)).length;

  const invMap = new Map(inventory.map((i) => [i.sku, i]));
  const conflicts = orders.filter((o) => {
    const skus = o.requiredSkus.split(',').map((s) => s.trim());
    return skus.some((sku) => {
      const item = invMap.get(sku);
      const reserved = reservedBySku[sku] || 0;
      return !item || (item.stock || 0) - reserved < skus.filter((s) => s === sku).length;
    });
  }).length;

  const topReserved = Object.entries(reservedBySku)
    .map(([sku, reserved]) => {
      const item = invMap.get(sku);
      return { sku, reserved, available: (item?.stock || 0) - reserved };
    })
    .sort((a, b) => b.reserved - a.reserved)
    .slice(0, 5);

  return {
    activeReservations: active.length,
    totalReservations: active.length,
    totalReservedUnits: active.reduce((s, r) => s + r.quantity, 0),
    pendingAllocations,
    conflicts,
    fefoEligible: inventory.filter((i) => i.expiryDate || i.fefoPriority).length,
    topReserved,
  };
}

export async function autoAllocatePendingOrders(operator: string): Promise<{ allocated: number; failed: number }> {
  const orders = await db.orders.where('status').equals('Pending').toArray();
  const existing = await db.inventoryReservations.toArray();
  const allocatedIds = new Set(existing.map((r) => r.orderId));

  let allocated = 0;
  let failed = 0;

  const sorted = [...orders]
    .filter((o) => !allocatedIds.has(o.orderId))
    .sort((a, b) => {
      const prio = { urgent: 0, high: 1, normal: 2 };
      return prio[a.priority] - prio[b.priority];
    });

  for (const order of sorted) {
    const result = await allocateOrder(order, operator);
    if (result.success) allocated++;
    else failed++;
  }

  return { allocated, failed };
}
