/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { db, logAction, type User } from './db';
import {
  hashPasswordLocal,
  verifyPasswordLocal,
  hasPermission,
  canAccessRoute,
  canAccessWarehouse,
  encryptSessionEnvelope,
  decryptSessionEnvelope,
  type WmsRole,
} from './security';
import {
  supabase,
  WMS_TENANT_CODE,
  WMS_DEFAULT_WAREHOUSE,
  isSupabaseConfigured,
  setActiveServerSessionToken,
  getActiveServerSessionToken,
} from './supabase';
import { safeLocalStorage, safeSessionStorage, safeRandomId } from './safeStorage';

export interface AuthUser {
  id: number | string;
  username: string;
  role: WmsRole;
  displayName: string;
  tenantCode: string;
  warehouseCode: string;
  warehouseName?: string;
  allowedWarehouses: string[];
  authMode: 'supabase-pgcrypto' | 'edge-pbkdf2';
}

interface EncryptedSessionPayload {
  user: AuthUser;
  serverSessionToken: string | null;
  expiresAt: string;
  issuedAt: string;
}

interface LockoutRecord {
  count: number;
  lockedUntil: number;
}

export interface LoginOutcome {
  ok: boolean;
  code?: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'WAREHOUSE_FORBIDDEN' | 'TENANT_REQUIRED';
  message?: string;
  lockedUntil?: string;
  remainingAttempts?: number;
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username: string, password: string, warehouseCode?: string) => Promise<boolean>;
  loginDetailed: (username: string, password: string, warehouseCode?: string) => Promise<LoginOutcome>;
  logout: () => void;
  switchWarehouse: (warehouseCode: string) => Promise<{ ok: boolean; error?: string }>;
  isAdmin: boolean;
  isSupervisor: boolean;
  can: (permission: string) => boolean;
  canAccessModule: (path: string) => boolean;
  loading: boolean;
  lastAuthError: string | null;
  updateUser: (updates: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => false,
  loginDetailed: async () => ({ ok: false }),
  logout: () => {},
  switchWarehouse: async () => ({ ok: false }),
  isAdmin: false,
  isSupervisor: false,
  can: () => false,
  canAccessModule: () => false,
  loading: true,
  lastAuthError: null,
  updateUser: () => {},
});

const SESSION_TIMEOUT_MINUTES = 45;
const MAX_FAILED_ATTEMPTS = 5;
const SESSION_STORAGE_KEY = 'yesi_wms_session_enc_v2';
const LEGACY_LOCALSTORAGE_KEY = 'vortex_session';
const LOCKOUT_PREF_PREFIX = 'auth_lockout:';

function getDeviceId(): string {
  let id = safeSessionStorage.getItem('yesi_device_id');
  if (!id) {
    id = `dev-${safeRandomId().slice(0, 12)}`;
    safeSessionStorage.setItem('yesi_device_id', id);
  }
  return id;
}

async function getLocalLockout(username: string): Promise<LockoutRecord> {
  try {
    const key = `${LOCKOUT_PREF_PREFIX}${username.toLowerCase()}`;
    const row = await db.preferences.where('key').equals(key).first();
    if (!row?.value) return { count: 0, lockedUntil: 0 };
    const parsed = JSON.parse(row.value) as LockoutRecord;
    return {
      count: Number(parsed.count || 0),
      lockedUntil: Number(parsed.lockedUntil || 0),
    };
  } catch {
    return { count: 0, lockedUntil: 0 };
  }
}

async function saveLocalLockout(username: string, record: LockoutRecord): Promise<void> {
  try {
    const key = `${LOCKOUT_PREF_PREFIX}${username.toLowerCase()}`;
    const existing = await db.preferences.where('key').equals(key).first();
    const value = JSON.stringify(record);
    if (existing?.id != null) {
      await db.preferences.update(existing.id, { value, createdAt: new Date().toISOString() });
    } else {
      await db.preferences.add({ key, value, createdAt: new Date().toISOString() });
    }
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAuthError, setLastAuthError] = useState<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const userRef = useRef<AuthUser | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const clearClientSession = useCallback(() => {
    safeSessionStorage.removeItem(SESSION_STORAGE_KEY);
    safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
    setActiveServerSessionToken(null);
    setUser(null);
  }, []);

  const persistEncryptedSession = useCallback(async (sessionUser: AuthUser, serverToken: string | null) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TIMEOUT_MINUTES * 60 * 1000);
    const payload: EncryptedSessionPayload = {
      user: sessionUser,
      serverSessionToken: serverToken,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    setActiveServerSessionToken(serverToken);
    try {
      safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
      const encrypted = await encryptSessionEnvelope(payload);
      safeSessionStorage.setItem(SESSION_STORAGE_KEY, encrypted);
    } catch {
      // Keep in-memory session even if storage quota/crypto fails
    }
    setUser(sessionUser);
    lastActivityRef.current = Date.now();
  }, []);

  // Restore & strictly validate encrypted session on startup
  useEffect(() => {
    let cancelled = false;
    async function restoreSession() {
      try {
        // Purge any legacy plaintext localStorage session immediately
        safeLocalStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);

        const raw = safeSessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
          if (!cancelled) setLoading(false);
          return;
        }

        const decoded = await decryptSessionEnvelope<EncryptedSessionPayload>(raw);
        if (!decoded || !decoded.user || !decoded.expiresAt || new Date(decoded.expiresAt) <= new Date()) {
          clearClientSession();
          if (!cancelled) setLoading(false);
          return;
        }

        // Enforce tenant match
        if (decoded.user.tenantCode !== WMS_TENANT_CODE) {
          clearClientSession();
          if (!cancelled) setLoading(false);
          return;
        }

        // Re-verify server-side session token if online & issued by Supabase
        if (
          decoded.serverSessionToken &&
          isSupabaseConfigured &&
          (typeof navigator === 'undefined' || navigator.onLine)
        ) {
          try {
            const { data, error } = await supabase.rpc('wms_validate_session', {
              p_session_token: decoded.serverSessionToken,
              p_tenant_code: decoded.user.tenantCode,
              p_warehouse_code: decoded.user.warehouseCode,
            });
            if (error || !data?.valid) {
              clearClientSession();
              if (!cancelled) setLoading(false);
              return;
            }
          } catch {
            // Network transiently unreachable: allow valid unexpired AES-GCM session to continue offline
          }
        }

        if (!cancelled) {
          setActiveServerSessionToken(decoded.serverSessionToken);
          setUser(decoded.user);
          setLoading(false);
        }
      } catch {
        clearClientSession();
        if (!cancelled) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [clearClientSession]);

  const logout = useCallback(() => {
    const current = userRef.current;
    const token = getActiveServerSessionToken();
    if (current) {
      void logAction('LOGOUT', `User ${current.username} logged out from ${current.warehouseCode}`, current.displayName);
    }
    if (token && isSupabaseConfigured) {
      void Promise.resolve(supabase.rpc('wms_revoke_session', { p_session_token: token })).catch(() => {});
    }
    clearClientSession();
  }, [clearClientSession]);

  // Rolling inactivity session timeout (tracked via ref to ensure zero React re-renders on floor pointer/scroll activity)
  useEffect(() => {
    if (!user) return;
    lastActivityRef.current = Date.now();

    const checkTimeout = () => {
      const inactive = Date.now() - lastActivityRef.current;
      if (inactive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
        void logAction('SESSION_EXPIRED', `Inactivity timeout for ${user.username}`, user.displayName);
        logout();
      }
    };

    const interval = setInterval(checkTimeout, 30_000);
    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };
    activityEvents.forEach((e) => window.addEventListener(e, updateActivity, { passive: true }));

    return () => {
      clearInterval(interval);
      activityEvents.forEach((e) => window.removeEventListener(e, updateActivity));
    };
  }, [user, logout]);

  const loginDetailed = useCallback(
    async (username: string, password: string, requestedWarehouse?: string): Promise<LoginOutcome> => {
      const cleanUser = username.trim();
      const targetWh = (requestedWarehouse || WMS_DEFAULT_WAREHOUSE).trim().toUpperCase();
      setLastAuthError(null);

      if (!cleanUser || !password) {
        const msg = 'Username and password are required.';
        setLastAuthError(msg);
        return { ok: false, code: 'INVALID_CREDENTIALS', message: msg };
      }

      // Check durable local lockout state first (prevents brute-force across reloads)
      const localLock = await getLocalLockout(cleanUser);
      if (localLock.lockedUntil > Date.now()) {
        const minsLeft = Math.max(1, Math.ceil((localLock.lockedUntil - Date.now()) / 60_000));
        const msg = `Account temporarily locked due to failed login attempts. Try again in ${minsLeft} min.`;
        setLastAuthError(msg);
        await logAction('LOGIN_LOCKED_BLOCKED', `Blocked login attempt for locked account ${cleanUser}`, cleanUser);
        return {
          ok: false,
          code: 'ACCOUNT_LOCKED',
          message: msg,
          lockedUntil: new Date(localLock.lockedUntil).toISOString(),
        };
      }

      // 1. Primary Cloud Authentication via Supabase PostgreSQL v2 RPC (pgcrypto + server lockout + signed token)
      if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        try {
          const { data, error } = await supabase.rpc('wms_authenticate_user_v2', {
            p_username: cleanUser,
            p_password: password,
            p_tenant_code: WMS_TENANT_CODE,
            p_warehouse_code: targetWh,
            p_device_id: getDeviceId(),
            p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : 'YESI-WMS',
          });

          if (!error && data) {
            if (!data.authenticated) {
              if (data.code === 'ACCOUNT_LOCKED') {
                const lockUntilMs = data.locked_until
                  ? new Date(data.locked_until).getTime()
                  : Date.now() + 5 * 60_000;
                await saveLocalLockout(cleanUser, { count: MAX_FAILED_ATTEMPTS, lockedUntil: lockUntilMs });
              }
              const msg = data.error || 'Invalid credentials.';
              setLastAuthError(msg);
              return {
                ok: false,
                code: data.code || 'INVALID_CREDENTIALS',
                message: msg,
                remainingAttempts: data.remaining_attempts,
                lockedUntil: data.locked_until,
              };
            }

            if (data.authenticated && data.user) {
              const u = data.user;
              const mappedRole: WmsRole = (
                ['admin', 'supervisor', 'operator', 'auditor', 'viewer'].includes(u.role)
                  ? u.role
                  : 'operator'
              ) as WmsRole;
              const allowedWarehouses: string[] = Array.isArray(u.allowedWarehouses) && u.allowedWarehouses.length > 0
                ? u.allowedWarehouses
                : [u.warehouseCode || targetWh];

              // Mirror PBKDF2-SHA256 credential into local IndexedDB when available (never abort cloud login if IndexedDB is blocked in cross-origin iframe)
              let localId: number | string = u.id;
              try {
                const localHash = await hashPasswordLocal(password);
                const allLocal = await db.users.toArray();
                const localMatch = allLocal.find((x) => x.username.toLowerCase() === cleanUser.toLowerCase());
                const persistedRole: 'admin' | 'supervisor' | 'operator' =
                  mappedRole === 'admin' || mappedRole === 'supervisor' ? mappedRole : 'operator';
                if (localMatch?.id != null) {
                  await db.users.update(localMatch.id, {
                    password: localHash,
                    role: persistedRole,
                    displayName: u.displayName || cleanUser,
                  });
                  localId = localMatch.id;
                } else {
                  localId = await db.users.add({
                    username: u.username || cleanUser,
                    password: localHash,
                    role: persistedRole,
                    displayName: u.displayName || cleanUser,
                    createdAt: new Date().toISOString(),
                    skillLevel: Number(u.skillLevel || 3),
                    currentZone: u.currentZone || 'PHONE-A',
                  });
                }
              } catch {
                // IndexedDB blocked/unavailable in sandboxed iframe — proceed with verified cloud session
              }

              const sessionUser: AuthUser = {
                id: localId,
                username: u.username || cleanUser,
                role: mappedRole,
                displayName: u.displayName || cleanUser,
                tenantCode: u.tenantCode || WMS_TENANT_CODE,
                warehouseCode: u.warehouseCode || targetWh,
                warehouseName: u.warehouseName || 'Fulfillment Center',
                allowedWarehouses,
                authMode: 'supabase-pgcrypto',
              };

              await saveLocalLockout(cleanUser, { count: 0, lockedUntil: 0 });
              await persistEncryptedSession(sessionUser, data.session_token || null);
              return { ok: true };
            }
          }
        } catch {
          // Network unreachable -> fall back to local PBKDF2-SHA256 edge verification
        }
      }

      // 2. Offline Edge Authentication via Web Crypto PBKDF2-SHA256
      let allUsers: User[] = [];
      try {
        allUsers = await db.users.toArray();
      } catch {
        // IndexedDB blocked/unavailable
      }
      const found = allUsers.find((u) => u.username.toLowerCase() === cleanUser.toLowerCase());

      if (found && found.id != null) {
        const valid = await verifyPasswordLocal(password, found.password);
        if (valid) {
          const allowedWarehouses = found.role === 'admin' ? ['DXB-FC1', 'MSK-HUB2'] : [WMS_DEFAULT_WAREHOUSE];
          if (!canAccessWarehouse(found.role, allowedWarehouses, targetWh)) {
            const msg = `Operator ${found.username} is not authorized for warehouse ${targetWh}.`;
            setLastAuthError(msg);
            await logAction('WAREHOUSE_SCOPE_DENIED', msg, found.displayName);
            return { ok: false, code: 'WAREHOUSE_FORBIDDEN', message: msg };
          }

          const sessionUser: AuthUser = {
            id: found.id,
            username: found.username,
            role: found.role,
            displayName: found.displayName,
            tenantCode: WMS_TENANT_CODE,
            warehouseCode: targetWh,
            allowedWarehouses,
            authMode: 'edge-pbkdf2',
          };
          await saveLocalLockout(cleanUser, { count: 0, lockedUntil: 0 });
          await persistEncryptedSession(sessionUser, null);
          await logAction('LOGIN_EDGE_SUCCESS', `User ${found.username} authenticated offline (${targetWh})`, found.displayName);
          return { ok: true };
        }
      }

      // Record failed attempt & apply progressive exponential lockout
      const nextCount = localLock.count + 1;
      const lockedUntil =
        nextCount >= MAX_FAILED_ATTEMPTS
          ? Date.now() + Math.min(60, 5 * (nextCount - MAX_FAILED_ATTEMPTS + 1)) * 60_000
          : 0;
      await saveLocalLockout(cleanUser, { count: nextCount, lockedUntil });
      await logAction('LOGIN_FAILED', `Failed login attempt #${nextCount} for ${cleanUser}`, cleanUser);

      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - nextCount);
      const msg =
        lockedUntil > 0
          ? 'Account locked after 5 failed attempts. Please wait 5 minutes or contact an administrator.'
          : `Invalid credentials (${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout).`;
      setLastAuthError(msg);

      return {
        ok: false,
        code: lockedUntil > 0 ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        message: msg,
        remainingAttempts: remaining,
        lockedUntil: lockedUntil > 0 ? new Date(lockedUntil).toISOString() : undefined,
      };
    },
    [persistEncryptedSession]
  );

  const login = useCallback(
    async (username: string, password: string, warehouseCode?: string): Promise<boolean> => {
      const res = await loginDetailed(username, password, warehouseCode);
      return res.ok;
    },
    [loginDetailed]
  );

  const switchWarehouse = useCallback(
    async (warehouseCode: string): Promise<{ ok: boolean; error?: string }> => {
      const current = userRef.current;
      if (!current) return { ok: false, error: 'Not authenticated' };
      const cleanWh = warehouseCode.trim().toUpperCase();
      if (!canAccessWarehouse(current.role, current.allowedWarehouses, cleanWh)) {
        const msg = `Role ${current.role} is not scoped to warehouse ${cleanWh}`;
        await logAction('WAREHOUSE_SWITCH_DENIED', msg, current.displayName);
        return { ok: false, error: msg };
      }

      const token = getActiveServerSessionToken();
      if (token && isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
        const { data, error } = await supabase.rpc('wms_validate_session', {
          p_session_token: token,
          p_tenant_code: current.tenantCode,
          p_warehouse_code: cleanWh,
        });
        if (error || !data?.valid) {
          return { ok: false, error: data?.error || error?.message || 'Warehouse validation failed' };
        }
      }

      const updated: AuthUser = { ...current, warehouseCode: cleanWh };
      await persistEncryptedSession(updated, token);
      await logAction('WAREHOUSE_SWITCHED', `Switched active warehouse to ${cleanWh}`, current.displayName);
      return { ok: true };
    },
    [persistEncryptedSession]
  );

  const updateUser = useCallback(
    (updates: Partial<AuthUser>) => {
      setUser((prev) => {
        if (!prev) return null;
        const updated = { ...prev, ...updates };
        void persistEncryptedSession(updated, getActiveServerSessionToken());
        return updated;
      });
    },
    [persistEncryptedSession]
  );

  const can = useCallback(
    (permission: string) => hasPermission(user?.role, permission),
    [user?.role]
  );

  const canAccessModule = useCallback(
    (path: string) => canAccessRoute(user?.role, path),
    [user?.role]
  );

  const contextValue = React.useMemo<AuthContextType>(
    () => ({
      user,
      login,
      loginDetailed,
      logout,
      switchWarehouse,
      isAdmin: user?.role === 'admin',
      isSupervisor: user?.role === 'admin' || user?.role === 'supervisor',
      can,
      canAccessModule,
      loading,
      lastAuthError,
      updateUser,
    }),
    [user, loading, lastAuthError, login, loginDetailed, logout, switchWarehouse, can, canAccessModule, updateUser]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
