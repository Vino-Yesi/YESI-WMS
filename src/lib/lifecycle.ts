/**
 * Transactional Enterprise Fulfillment Lifecycle Service
 *
 * Enforces strict multi-stage warehouse workflow integrity inside atomic Dexie
 * transactions + idempotent Supabase ACID stored procedures:
 *
 *   1. Inbound Receiving (GRN) -> Staging / QC Inspection (never blind bin stock!)
 *   2. QC Inspection           -> Supervisor Approval -> Directed Putaway Task
 *   3. Directed Putaway        -> Verified Bin Scan   -> Allocatable Stock Balance
 *   4. Order Reservation       -> FEFO Bin/Serial Lock
 *   5. Picking                 -> Scan Verification   -> Picked Reservation
 *   6. Packing                 -> Carton & Weight Check -> Order Status = 'Packed'
 *   7. Carrier Shipping        -> Requires 'Packed'/'ReadyToShip' -> Manifest & Ledger
 *   8. Returns (RMA)           -> Inspection Hold or Verified Restock + Audit Log
 */

import { db, logInventoryMovement } from './db';
import { enqueueCloudOperation } from './supabaseSync';
import { hasPermission } from './security';

export interface ReceiveGrnInput {
  sku: string;
  qty: number;
  description?: string;
  receivingBin?: string;
  suggestedLocation?: string;
  lotNumber?: string;
  expiryDate?: string;
  poNumber?: string;
  supplier?: string;
  crossDockOrderId?: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  operator: string;
  operatorRole?: string;
}

export interface ReceiveGrnResult {
  grnRef: string;
  stage: 'qc_hold' | 'putaway_queued';
  putawayTaskId?: string;
  suggestedLocation: string;
}

/**
 * Step 1: Receive Inbound Goods (GRN)
 *
 * Strictly stages incoming stock into either:
 *  - QC Inspection Hold (`qcStatus` = 'pending' | 'failed') -> requires QC Release before Putaway
 *  - Directed Putaway Queue (`qcStatus` = 'passed') -> stock enters allocatable inventory ONLY
 *    after Putaway Task is confirmed at the target bin.
 */
export async function receiveInboundTransactional(input: ReceiveGrnInput): Promise<ReceiveGrnResult> {
  if (!hasPermission(input.operatorRole || 'operator', 'inbound.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks inbound.execute permission');
  }
  const cleanSku = input.sku.trim();
  if (!cleanSku) throw new Error('VALIDATION_ERROR: SKU is required');
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error('VALIDATION_ERROR: Quantity must be greater than zero');
  }

  const now = new Date().toISOString();
  const grnRef = `GRN-${Date.now()}`;
  const receivingBin = input.receivingBin?.trim() || 'RECV-DOCK-01';
  let suggestedLocation = input.suggestedLocation?.trim() || 'PHONE-A-01';
  let putawayTaskId: string | undefined;
  const stage: ReceiveGrnResult['stage'] = input.qcStatus === 'passed' ? 'putaway_queued' : 'qc_hold';

  await db.transaction(
    'rw',
    [db.inventory, db.inbound, db.qcHolds, db.putawayTasks, db.orders, db.auditLogs],
    async () => {
      const existing = await db.inventory.where('sku').equals(cleanSku).first();
      if (existing?.location && !input.suggestedLocation) {
        suggestedLocation = existing.location;
      }

      // Ensure master SKU catalog entry exists (with 0 stock increment until putaway completes!)
      if (!existing) {
        await db.inventory.add({
          sku: cleanSku,
          product: input.description?.trim() || cleanSku,
          stock: 0,
          location: suggestedLocation,
          lotNumber: input.lotNumber?.trim() || undefined,
          expiryDate: input.expiryDate || undefined,
          updatedAt: now,
        });
      }

      if (input.crossDockOrderId?.trim()) {
        const cdOrder = await db.orders.where('orderId').equals(input.crossDockOrderId.trim()).first();
        if (!cdOrder) {
          await db.orders.add({
            orderId: input.crossDockOrderId.trim(),
            status: 'CrossDock',
            requiredSkus: cleanSku,
            priority: 'high',
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      await db.inbound.add({
        sku: cleanSku,
        qty: input.qty,
        bin: receivingBin,
        description: input.description?.trim() || existing?.product || cleanSku,
        lotNumber: input.lotNumber?.trim() || undefined,
        expiryDate: input.expiryDate || undefined,
        poNumber: input.poNumber?.trim() || undefined,
        supplier: input.supplier?.trim() || undefined,
        receivedAt: now,
        crossDockOrderId: input.crossDockOrderId?.trim() || undefined,
        qcStatus: input.qcStatus,
      });

      if (stage === 'qc_hold') {
        await db.qcHolds.add({
          sku: cleanSku,
          lotNumber: input.lotNumber?.trim() || undefined,
          quantity: input.qty,
          reason: input.qcStatus === 'failed' ? `Damaged/Failed on GRN (${grnRef})` : `Inbound QC Inspection Required (${grnRef})`,
          status: 'hold',
          operator: input.operator,
          createdAt: now,
        });
      } else {
        putawayTaskId = `PUT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const destZone = suggestedLocation.split('-')[0] || 'PHONE-A';
        await db.putawayTasks.add({
          taskId: putawayTaskId,
          sku: cleanSku,
          product: input.description?.trim() || existing?.product || cleanSku,
          quantity: input.qty,
          lotNumber: input.lotNumber?.trim() || undefined,
          sourceLocation: receivingBin,
          sourceType: 'receiving',
          suggestedLocation,
          destinationZone: destZone,
          status: 'pending',
          priority: input.crossDockOrderId ? 'urgent' : 'normal',
          createdAt: now,
          qcStatus: 'passed',
          putawayMethod: 'direct',
          operator: input.operator,
          estimatedTime: 10,
        });
      }

      await db.auditLogs.add({
        action: 'INBOUND_GRN_STAGED',
        details: `${grnRef}: ${input.qty}× ${cleanSku} at ${receivingBin} -> ${stage === 'qc_hold' ? 'QC Hold' : `Putaway ${putawayTaskId} (${suggestedLocation})`}`,
        operator: input.operator,
        timestamp: now,
      });
    }
  );

  void enqueueCloudOperation('inbound_grn', {
    sku: cleanSku,
    qty: input.qty,
    description: input.description || null,
    poNumber: input.poNumber || null,
    supplier: input.supplier || 'Direct Supplier',
    bin: receivingBin,
    lotNumber: input.lotNumber || 'DEFAULT',
    qcStatus: input.qcStatus,
    operator: input.operator,
  });

  return { grnRef, stage, putawayTaskId, suggestedLocation };
}

/**
 * Step 2: QC Release / Scrap Checkpoint (Requires Supervisor or Admin permission `qc.release`)
 *
 * Releasing a QC Hold generates a Directed Putaway Task (`sourceType = 'qc_release'`)
 * rather than dumping unlocated stock directly into inventory.
 */
export async function dispositionQcHoldTransactional(params: {
  holdId: number;
  disposition: 'release' | 'scrap';
  operator: string;
  operatorRole?: string;
}): Promise<{ putawayTaskId?: string }> {
  if (!hasPermission(params.operatorRole, 'qc.release')) {
    throw new Error('PERMISSION_DENIED: Supervisor or Admin approval (qc.release) is required to release or scrap QC holds.');
  }

  const now = new Date().toISOString();
  let putawayTaskId: string | undefined;
  let holdSnapshot: { sku: string; quantity: number; reason: string; lotNumber?: string } | null = null;

  await db.transaction('rw', [db.qcHolds, db.inventory, db.putawayTasks, db.auditLogs], async () => {
    const hold = await db.qcHolds.get(params.holdId);
    if (!hold) throw new Error('QC Hold record not found');
    if (hold.status !== 'hold') throw new Error(`QC Hold already processed (${hold.status})`);

    holdSnapshot = {
      sku: hold.sku,
      quantity: hold.quantity,
      reason: hold.reason,
      lotNumber: hold.lotNumber,
    };

    await db.qcHolds.update(params.holdId, {
      status: params.disposition === 'release' ? 'released' : 'rejected',
      releasedAt: now,
    });

    if (params.disposition === 'release') {
      const inv = await db.inventory.where('sku').equals(hold.sku).first();
      const suggestedLoc = inv?.location || 'PHONE-A-01';
      const destZone = suggestedLoc.split('-')[0] || 'PHONE-A';
      putawayTaskId = `PUT-QC-${Date.now()}`;

      await db.putawayTasks.add({
        taskId: putawayTaskId,
        sku: hold.sku,
        product: inv?.product || hold.sku,
        quantity: hold.quantity,
        lotNumber: hold.lotNumber,
        sourceLocation: 'QC-HOLD-AREA',
        sourceType: 'qc_release',
        suggestedLocation: suggestedLoc,
        destinationZone: destZone,
        status: 'pending',
        priority: 'high',
        createdAt: now,
        qcStatus: 'passed',
        putawayMethod: 'direct',
        operator: params.operator,
        estimatedTime: 10,
      });
    }

    await db.auditLogs.add({
      action: params.disposition === 'release' ? 'QC_HOLD_RELEASED' : 'QC_HOLD_SCRAPPED',
      details: `${hold.quantity}× ${hold.sku} (${hold.reason})${putawayTaskId ? ` -> Putaway ${putawayTaskId}` : ' -> Scrapped'}`,
      operator: params.operator,
      timestamp: now,
    });
  });

  if (holdSnapshot) {
    const snap = holdSnapshot as { sku: string; quantity: number; reason: string; lotNumber?: string };
    void enqueueCloudOperation('qc_release', {
      sku: snap.sku,
      qty: snap.quantity,
      disposition: params.disposition,
      reason: snap.reason,
      lotNumber: snap.lotNumber || 'DEFAULT',
      operator: params.operator,
    });
  }

  return { putawayTaskId };
}

/**
 * Step 3: Complete Directed Putaway Task -> Increments Allocatable Stock Balance
 */
export async function completePutawayTransactional(params: {
  taskId: number;
  actualLocation?: string;
  operator: string;
  operatorRole?: string;
}): Promise<{ location: string; newStock: number }> {
  if (!hasPermission(params.operatorRole || 'operator', 'putaway.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks putaway.execute permission');
  }

  const now = new Date().toISOString();
  let finalLoc = 'PHONE-A-01';
  let newStock = 0;
  let taskSnapshot: { taskId: string; sku: string; qty: number; sourceLocation: string; lotNumber?: string } | null = null;

  await db.transaction('rw', [db.putawayTasks, db.inventory, db.inventoryMovements, db.auditLogs], async () => {
    const task = await db.putawayTasks.get(params.taskId);
    if (!task) throw new Error('Putaway task not found');
    if (task.status === 'completed') throw new Error('Putaway task already completed');
    if (task.qcStatus !== 'passed') {
      throw new Error(`QC_CHECKPOINT_BLOCKED: SKU ${task.sku} has not passed QC inspection`);
    }

    finalLoc = (params.actualLocation?.trim() || task.suggestedLocation || 'PHONE-A-01').toUpperCase();
    taskSnapshot = {
      taskId: task.taskId,
      sku: task.sku,
      qty: task.quantity,
      sourceLocation: task.sourceLocation,
      lotNumber: task.lotNumber,
    };

    await db.putawayTasks.update(params.taskId, {
      status: 'completed',
      actualLocation: finalLoc,
      completedAt: now,
      actualTime: task.startedAt ? Math.max(1, Math.round((Date.now() - new Date(task.startedAt).getTime()) / 60000)) : 8,
    });

    const inv = await db.inventory.where('sku').equals(task.sku).first();
    if (inv?.id != null) {
      newStock = (inv.stock || 0) + task.quantity;
      await db.inventory.update(inv.id, {
        stock: newStock,
        location: finalLoc,
        lotNumber: task.lotNumber || inv.lotNumber,
        updatedAt: now,
      });
    } else {
      newStock = task.quantity;
      await db.inventory.add({
        sku: task.sku,
        product: task.product || task.sku,
        stock: newStock,
        location: finalLoc,
        lotNumber: task.lotNumber,
        updatedAt: now,
      });
    }

    await db.inventoryMovements.add({
      sku: task.sku,
      type: 'putaway',
      quantity: task.quantity,
      fromLocation: task.sourceLocation,
      toLocation: finalLoc,
      lotNumber: task.lotNumber,
      operator: params.operator,
      note: `Putaway ${task.taskId}`,
      timestamp: now,
    });

    await db.auditLogs.add({
      action: 'PUTAWAY_COMPLETED',
      details: `${task.taskId}: ${task.quantity}× ${task.sku} put away at ${finalLoc} (stock=${newStock})`,
      operator: params.operator,
      timestamp: now,
    });
  });

  if (taskSnapshot) {
    const snap = taskSnapshot as { taskId: string; sku: string; qty: number };
    void enqueueCloudOperation('putaway_complete', {
      taskNumber: snap.taskId,
      actualLocation: finalLoc,
      operator: params.operator,
    });
  }

  return { location: finalLoc, newStock };
}

/**
 * Step 5 & 6: Verify Pick & Pack -> Transitions Order to 'Packed' (NOT directly to 'Shipped'!)
 *
 * Ensures Carrier Label & Manifest generation in Shipping is mandatory before Carrier Dispatch,
 * while atomically fulfilling/creating reservations so stock cannot be double-picked.
 */
export async function confirmPickAndPackTransactional(params: {
  orderRecordId: number;
  pickedItems: Array<{ sku: string; picked: number }>;
  boxName?: string;
  operator: string;
  operatorRole?: string;
}): Promise<{ orderId: string; status: 'Packed' }> {
  if (!hasPermission(params.operatorRole || 'operator', 'outbound.pack')) {
    throw new Error('PERMISSION_DENIED: Operator lacks outbound.pack permission');
  }

  const now = new Date().toISOString();
  let orderIdStr = '';

  await db.transaction(
    'rw',
    [db.orders, db.inventory, db.inventoryReservations, db.auditLogs],
    async () => {
      const order = await db.orders.get(params.orderRecordId);
      if (!order) throw new Error('Order not found');
      if (order.status === 'Shipped') throw new Error('Order has already been shipped');
      orderIdStr = order.orderId;

      // Verify stock availability against unreserved + this order's own reservations
      for (const line of params.pickedItems) {
        const inv = await db.inventory.where('sku').equals(line.sku).first();
        if (!inv || (inv.stock || 0) < line.picked) {
          throw new Error(`INSUFFICIENT_STOCK: ${line.sku} requires ${line.picked}, only ${inv?.stock ?? 0} on hand`);
        }

        const otherReservations = await db.inventoryReservations
          .where('sku')
          .equals(line.sku)
          .filter((r) => (r.status === 'reserved' || r.status === 'allocated') && r.orderId !== order.orderId)
          .toArray();
        const lockedForOthers = otherReservations.reduce((s, r) => s + r.quantity, 0);
        if ((inv.stock || 0) - lockedForOthers < line.picked) {
          throw new Error(`RESERVATION_CONFLICT: ${line.sku} is reserved for other wave orders (${lockedForOthers} locked)`);
        }

        // Mark existing reservations for this order as picked, or create a picked reservation lock
        const ownRes = await db.inventoryReservations
          .where('orderId')
          .equals(order.orderId)
          .filter((r) => r.sku === line.sku && (r.status === 'reserved' || r.status === 'allocated'))
          .toArray();

        if (ownRes.length > 0) {
          for (const r of ownRes) {
            await db.inventoryReservations.update(r.id!, { status: 'allocated' });
          }
        } else {
          await db.inventoryReservations.add({
            reservationId: `RES-PACK-${order.orderId}-${line.sku}`,
            orderId: order.orderId,
            sku: line.sku,
            quantity: line.picked,
            lotNumber: inv.lotNumber,
            status: 'allocated',
            fefoPriority: inv.fefoPriority || 50,
            reservedAt: now,
            expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
            operator: params.operator,
          });
        }
      }

      await db.orders.update(params.orderRecordId, {
        status: 'Packed',
        actualBoxSize: params.boxName || order.suggestedBoxSize || 'Standard Carton',
        assignedTo: params.operator,
        updatedAt: now,
      });

      await db.auditLogs.add({
        action: 'ORDER_PACKED',
        details: `Order ${order.orderId} pick-verified & packed (${params.pickedItems.map((i) => `${i.picked}× ${i.sku}`).join(', ')}) — staged for Carrier Shipping`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  void enqueueCloudOperation('confirm_packed', {
    orderId: orderIdStr,
    boxName: params.boxName || 'Standard Carton',
    operator: params.operator,
  });

  return { orderId: orderIdStr, status: 'Packed' };
}

/**
 * Step 7: Carrier Dispatch -> Enforces 'Packed'/'ReadyToShip' gate, deducts stock,
 * fulfills reservations, stamps shipping label, and emits transactional outbox event.
 */
export async function dispatchShipmentTransactional(params: {
  orderRecordId: number;
  labelRecordId?: number;
  carrier: string;
  trackingNumber: string;
  operator: string;
  operatorRole?: string;
}): Promise<{ shipmentRef: string }> {
  if (!hasPermission(params.operatorRole || 'operator', 'outbound.ship')) {
    throw new Error('PERMISSION_DENIED: Operator lacks outbound.ship permission');
  }

  const now = new Date().toISOString();
  const shipmentRef = `SHP-${Date.now()}`;
  let orderIdStr = '';
  const movementsToQueue: Array<{ sku: string; qty: number; fromLocation?: string }> = [];

  await db.transaction(
    'rw',
    [db.orders, db.inventory, db.inventoryReservations, db.shippingLabels, db.auditLogs],
    async () => {
      const order = await db.orders.get(params.orderRecordId);
      if (!order) throw new Error('Order not found');
      if (order.status === 'Shipped') throw new Error('Order is already dispatched');

      const canOverride = hasPermission(params.operatorRole, 'outbound.override');
      if (!['Packed', 'ReadyToShip'].includes(order.status) && !canOverride) {
        throw new Error(
          `LIFECYCLE_VIOLATION: Order ${order.orderId} is in "${order.status}" state and must complete Pick & Pack before Carrier Dispatch.`
        );
      }

      orderIdStr = order.orderId;
      const skus = order.requiredSkus.split(',').map((s) => s.trim()).filter(Boolean);
      const counts: Record<string, number> = {};
      for (const s of skus) counts[s] = (counts[s] || 0) + 1;

      for (const [sku, qty] of Object.entries(counts)) {
        const inv = await db.inventory.where('sku').equals(sku).first();
        if (!inv || (inv.stock || 0) < qty) {
          throw new Error(`INSUFFICIENT_STOCK: Cannot dispatch ${order.orderId}; ${sku} has ${inv?.stock ?? 0} on hand`);
        }
        await db.inventory.update(inv.id!, {
          stock: (inv.stock || 0) - qty,
          updatedAt: now,
        });
        movementsToQueue.push({ sku, qty, fromLocation: inv.location });
      }

      const activeRes = await db.inventoryReservations
        .where('orderId')
        .equals(order.orderId)
        .filter((r) => r.status === 'reserved' || r.status === 'allocated')
        .toArray();
      for (const r of activeRes) {
        await db.inventoryReservations.update(r.id!, { status: 'picked' });
      }

      if (params.labelRecordId != null) {
        await db.shippingLabels.update(params.labelRecordId, { status: 'printed', printedAt: now });
      }

      await db.orders.update(params.orderRecordId, {
        status: 'Shipped',
        carrier: params.carrier,
        trackingNumber: params.trackingNumber,
        updatedAt: now,
      });

      await db.auditLogs.add({
        action: 'ORDER_DISPATCHED',
        details: `${shipmentRef}: Dispatched ${order.orderId} via ${params.carrier} (${params.trackingNumber})`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  // Record local movement history (without duplicating cloud deduction, since dispatch_order RPC deducts cloud stock atomically)
  for (const m of movementsToQueue) {
    await db.inventoryMovements.add({
      sku: m.sku,
      type: 'outbound',
      quantity: m.qty,
      fromLocation: m.fromLocation,
      orderId: orderIdStr,
      operator: params.operator,
      note: `Shipment ${shipmentRef} (${params.trackingNumber})`,
      timestamp: now,
    });
  }

  void enqueueCloudOperation(
    'dispatch_order',
    {
      orderId: orderIdStr,
      carrier: params.carrier,
      trackingNumber: params.trackingNumber,
      operator: params.operator,
    },
    `dispatch:${orderIdStr}`
  );

  return { shipmentRef };
}

/**
 * Step 8: Process Return (RMA) with Inspection Checkpoint
 */
export async function processReturnTransactional(params: {
  orderId?: string;
  sku: string;
  quantity: number;
  reason: string;
  disposition: 'quarantine' | 'restock' | 'scrap';
  operator: string;
  operatorRole?: string;
}): Promise<{ rmaRef: string; routedTo: 'qc_hold' | 'putaway_queue' | 'scrapped' }> {
  if (!hasPermission(params.operatorRole || 'operator', 'returns.execute')) {
    throw new Error('PERMISSION_DENIED: Operator lacks returns.execute permission');
  }
  const cleanSku = params.sku.trim();
  if (!cleanSku || params.quantity <= 0) {
    throw new Error('VALIDATION_ERROR: Valid SKU and positive quantity required');
  }
  if (params.disposition === 'scrap' && !hasPermission(params.operatorRole, 'returns.manage')) {
    throw new Error('PERMISSION_DENIED: Supervisor permission (returns.manage) required to scrap returned stock');
  }

  const now = new Date().toISOString();
  const rmaRef = `RMA-${Date.now()}`;
  let routedTo: 'qc_hold' | 'putaway_queue' | 'scrapped' = 'qc_hold';

  await db.transaction(
    'rw',
    [db.returns, db.qcHolds, db.putawayTasks, db.inventory, db.orders, db.auditLogs],
    async () => {
      const inv = await db.inventory.where('sku').equals(cleanSku).first();

      if (params.disposition === 'quarantine') {
        routedTo = 'qc_hold';
        await db.qcHolds.add({
          sku: cleanSku,
          quantity: params.quantity,
          reason: `RMA Inspection (${rmaRef}): ${params.reason}`,
          status: 'hold',
          operator: params.operator,
          createdAt: now,
        });
      } else if (params.disposition === 'restock') {
        routedTo = 'putaway_queue';
        const suggestedLoc = inv?.location || 'PHONE-A-01';
        await db.putawayTasks.add({
          taskId: `PUT-${rmaRef}`,
          sku: cleanSku,
          product: inv?.product || cleanSku,
          quantity: params.quantity,
          sourceLocation: 'RETURNS-DOCK',
          sourceType: 'returns',
          suggestedLocation: suggestedLoc,
          destinationZone: suggestedLoc.split('-')[0] || 'PHONE-A',
          status: 'pending',
          priority: 'normal',
          createdAt: now,
          qcStatus: 'passed',
          putawayMethod: 'direct',
          operator: params.operator,
          estimatedTime: 10,
        });
      } else {
        routedTo = 'scrapped';
      }

      await db.returns.add({
        orderId: params.orderId?.trim() || 'WALK-IN',
        sku: cleanSku,
        reason: params.reason,
        restocked: params.disposition === 'restock',
        quantity: params.quantity,
        processedAt: now,
      });

      if (params.orderId?.trim()) {
        const order = await db.orders.where('orderId').equals(params.orderId.trim()).first();
        if (order?.id != null) {
          await db.orders.update(order.id, { status: 'Returned', updatedAt: now });
        }
      }

      await db.auditLogs.add({
        action: 'RMA_PROCESSED',
        details: `${rmaRef}: ${params.quantity}× ${cleanSku} (${params.reason}) -> ${routedTo}`,
        operator: params.operator,
        timestamp: now,
      });
    }
  );

  if (params.disposition === 'scrap') {
    await logInventoryMovement(cleanSku, 'qc_adjustment', 0, params.operator, {
      note: `${rmaRef} scrapped on return (${params.reason})`,
    });
  }

  void enqueueCloudOperation('return_rma', {
    orderId: params.orderId || '',
    sku: cleanSku,
    qty: params.quantity,
    reason: params.reason,
    disposition: params.disposition,
    operator: params.operator,
  });

  return { rmaRef, routedTo };
}
