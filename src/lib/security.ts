/**
 * Cryptographic Security Helpers for YESI-WMS Offline Edge Cache
 *
 * Replaces legacy plaintext password storage in IndexedDB with PBKDF2-SHA256
 * salted password verification using the browser's Web Crypto API, paired with
 * server-side PostgreSQL pgcrypto bcrypt verification on Supabase.
 */

const ITERATIONS = 100_000;
const HASH_PREFIX = 'pbkdf2_sha256$';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isHashedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(HASH_PREFIX);
}

export async function hashPasswordLocal(password: string): Promise<string> {
  if (isHashedSecret(password)) return password;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const digest = new Uint8Array(bits);
  return `${HASH_PREFIX}${ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(digest)}`;
}

export async function verifyPasswordLocal(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  // Automatic backward compatibility during migration if an unhashed legacy row exists
  if (!isHashedSecret(stored)) {
    return stored === password;
  }
  try {
    const body = stored.slice(HASH_PREFIX.length);
    const [iterStr, saltHex, expectedHex] = body.split('$');
    const iterations = parseInt(iterStr, 10) || ITERATIONS;
    const salt = hexToBytes(saltHex);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    const computedHex = bytesToHex(new Uint8Array(bits));
    // Constant-time string comparison
    if (computedHex.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < computedHex.length; i++) {
      diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export type WmsRole = 'admin' | 'supervisor' | 'operator' | 'auditor' | 'viewer';

export const ROLE_PERMISSIONS: Record<WmsRole, string[]> = {
  admin: ['*'],
  supervisor: [
    'dashboard.view',
    'inbound.manage',
    'putaway.manage',
    'inventory.manage',
    'cycle_count.approve',
    'qc.release',
    'outbound.manage',
    'replenishment.manage',
    'returns.manage',
    'labor.manage',
    'integrations.manage',
    'reports.view',
  ],
  operator: [
    'dashboard.view',
    'inbound.execute',
    'putaway.execute',
    'inventory.view',
    'outbound.execute',
    'returns.execute',
  ],
  auditor: [
    'dashboard.view',
    'inventory.view',
    'cycle_count.execute',
    'audit.view',
    'reports.view',
  ],
  viewer: ['dashboard.view', 'inventory.view', 'reports.view'],
};

export function hasPermission(role: string | undefined, permission: string): boolean {
  const r = (role || 'viewer') as WmsRole;
  const perms = ROLE_PERMISSIONS[r] || [];
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}
