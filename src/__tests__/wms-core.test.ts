import { describe, it, expect } from 'vitest';
import { hashPasswordLocal, verifyPasswordLocal, isHashedSecret, hasPermission } from '@/lib/security';
import { validateScan, buildSummary, type ExpectedLine } from '@/lib/scanValidation';
import { routeOptimizer, oracle, sentinel } from '@/lib/neuralOps';

describe('WMS Security & RBAC', () => {
  it('hashes passwords with PBKDF2-SHA256 and verifies constant-time', async () => {
    const hash = await hashPasswordLocal('VINOVJ-Secure-2026');
    expect(isHashedSecret(hash)).toBe(true);
    expect(hash).not.toContain('VINOVJ-Secure-2026');

    expect(await verifyPasswordLocal('VINOVJ-Secure-2026', hash)).toBe(true);
    expect(await verifyPasswordLocal('WrongPassword', hash)).toBe(false);
  });

  it('enforces granular role permissions across admin, supervisor, operator, auditor, viewer', () => {
    expect(hasPermission('admin', 'users.delete')).toBe(true);
    expect(hasPermission('supervisor', 'qc.release')).toBe(true);
    expect(hasPermission('supervisor', 'users.delete')).toBe(false);
    expect(hasPermission('operator', 'outbound.execute')).toBe(true);
    expect(hasPermission('operator', 'qc.release')).toBe(false);
    expect(hasPermission('auditor', 'cycle_count.execute')).toBe(true);
    expect(hasPermission('viewer', 'inbound.execute')).toBe(false);
  });
});

describe('WMS Scan Validation & Wave Accuracy', () => {
  const expected: ExpectedLine[] = [
    { trackingId: '78954582-0287-1', product: 'Samsung Galaxy A17', qty: 1 },
    { trackingId: '56848324-0106-1', product: 'Galaxy Watch 8', qty: 2 },
  ];

  it('validates expected scans, partial multi-unit scans, duplicates, and unknown barcodes', () => {
    const counts = new Map<string, number>();

    const ev1 = validateScan('78954582-0287-1', expected, counts);
    expect(ev1.verdict).toBe('VALID');
    counts.set('78954582-0287-1', 1);

    const evDup = validateScan('78954582-0287-1', expected, counts);
    expect(evDup.verdict).toBe('QTY_EXCEEDED');

    const evPart = validateScan('56848324-0106-1', expected, counts);
    expect(evPart.verdict).toBe('PARTIAL');
    counts.set('56848324-0106-1', 1);

    const evFull = validateScan('56848324-0106-1', expected, counts);
    expect(evFull.verdict).toBe('VALID');
    counts.set('56848324-0106-1', 2);

    const evUnknown = validateScan('99999999-0000-9', expected, counts);
    expect(evUnknown.verdict).toBe('UNKNOWN_ORDER');

    const summary = buildSummary(expected, [ev1, evPart, evFull]);
    expect(summary.missing).toHaveLength(0);
    expect(summary.valid).toBe(3);
  });
});

describe('WMS Quantum Route Optimizer, Oracle Forecast & Anomaly Sentinel', () => {
  it('optimizes multi-SKU pick route using nearest-neighbor + 2-opt', () => {
    const route = routeOptimizer.optimizeRoute([
      'Buds3ProSilver',
      'A17Black256',
      'Watch8Graphite40',
      'sS25FEWhite',
    ]);
    expect(route).toHaveLength(4);
    expect(route.every((p) => p.zone && p.x > 0 && p.y > 0)).toBe(true);
  });

  it('generates 7-day demand forecast and detects stock anomalies', () => {
    const forecast = oracle.forecast(7, 207);
    expect(forecast).not.toBeNull();
    expect(forecast!.forecast).toHaveLength(7);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(forecast!.stockoutRisk);

    const alerts = sentinel.scan(
      [
        { sku: 'SKU-NEG', stock: -2 },
        { sku: 'SKU-LOW', stock: 1 },
        { sku: 'SKU-OK-1', stock: 25 },
        { sku: 'SKU-OK-2', stock: 28 },
        { sku: 'SKU-OK-3', stock: 22 },
      ],
      [{ status: 'Open' }]
    );
    expect(alerts.some((a) => a.sku === 'SKU-NEG')).toBe(true);
  });
});
