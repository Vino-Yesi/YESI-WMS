/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { db, logAction } from './db';
import { hashPasswordLocal, verifyPasswordLocal, hasPermission } from './security';
import { supabase, WMS_TENANT_CODE, isSupabaseConfigured } from './supabase';

export interface AuthUser {
  id: number | string;
  username: string;
  role: 'admin' | 'operator' | 'supervisor';
  displayName: string;
  tenantCode?: string;
  warehouseCode?: string;
  warehouseName?: string;
  authMode?: 'supabase-pgcrypto' | 'edge-pbkdf2';
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAdmin: boolean;
  isSupervisor: boolean;
  can: (permission: string) => boolean;
  loading: boolean;
  updateUser: (updates: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => false,
  logout: () => {},
  isAdmin: false,
  isSupervisor: false,
  can: () => false,
  loading: true,
  updateUser: () => {},
});

const SESSION_TIMEOUT_MINUTES = 45;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 2 * 60 * 1000;

function getInitialUser(): AuthUser | null {
  try {
    const stored = localStorage.getItem('vortex_session');
    if (stored) {
      const session = JSON.parse(stored);
      if (session.expiresAt && new Date(session.expiresAt) > new Date()) {
        return session.user;
      }
      localStorage.removeItem('vortex_session');
    }
  } catch {
    localStorage.removeItem('vortex_session');
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getInitialUser);
  const [loading] = useState(false);
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  const failedAttemptsRef = useRef<{ count: number; lockedUntil: number }>({ count: 0, lockedUntil: 0 });
  const userRef = useRef(user);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const logout = useCallback(() => {
    const current = userRef.current;
    if (current) {
      void logAction('LOGOUT', `User ${current.username} logged out`, current.displayName);
    }
    localStorage.removeItem('vortex_session');
    void supabase.auth.signOut().catch(() => {});
    setUser(null);
  }, []);

  // Rolling inactivity session timeout
  useEffect(() => {
    if (!user) return;

    const checkTimeout = () => {
      const inactive = Date.now() - lastActivity;
      if (inactive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
        logout();
      }
    };

    const interval = setInterval(checkTimeout, 60_000);
    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    const updateActivity = () => setLastActivity(Date.now());
    activityEvents.forEach((e) => window.addEventListener(e, updateActivity, { passive: true }));

    return () => {
      clearInterval(interval);
      activityEvents.forEach((e) => window.removeEventListener(e, updateActivity));
    };
  }, [user, lastActivity, logout]);

  const persistSession = (sessionUser: AuthUser) => {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + SESSION_TIMEOUT_MINUTES);
    localStorage.setItem(
      'vortex_session',
      JSON.stringify({
        user: sessionUser,
        expiresAt: expiresAt.toISOString(),
      })
    );
    setUser(sessionUser);
    setLastActivity(Date.now());
  };

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    const cleanUser = username.trim();
    if (!cleanUser || !password) return false;

    const nowMs = Date.now();
    if (failedAttemptsRef.current.lockedUntil > nowMs) {
      return false;
    }

    // 1. Primary Cloud Authentication via Supabase PostgreSQL pgcrypto bcrypt RPC
    if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
      try {
        const { data, error } = await supabase.rpc('wms_authenticate_user', {
          p_username: cleanUser,
          p_password: password,
          p_tenant_code: WMS_TENANT_CODE,
        });

        if (!error && data && data.authenticated && data.user) {
          const u = data.user;
          const mappedRole: AuthUser['role'] =
            u.role === 'admin' || u.role === 'supervisor' ? u.role : 'operator';

          // Mirror PBKDF2-SHA256 credential into local IndexedDB for seamless offline fallback
          const localHash = await hashPasswordLocal(password);
          const allLocal = await db.users.toArray();
          const localMatch = allLocal.find((x) => x.username.toLowerCase() === cleanUser.toLowerCase());
          let localId: number | string = u.id;
          if (localMatch?.id != null) {
            await db.users.update(localMatch.id, {
              password: localHash,
              role: mappedRole,
              displayName: u.displayName || cleanUser,
            });
            localId = localMatch.id;
          } else {
            localId = await db.users.add({
              username: u.username || cleanUser,
              password: localHash,
              role: mappedRole,
              displayName: u.displayName || cleanUser,
              createdAt: new Date().toISOString(),
              skillLevel: Number(u.skillLevel || 3),
              currentZone: u.currentZone || 'PHONE-A',
            });
          }

          const sessionUser: AuthUser = {
            id: localId,
            username: u.username || cleanUser,
            role: mappedRole,
            displayName: u.displayName || cleanUser,
            tenantCode: u.tenantCode || WMS_TENANT_CODE,
            warehouseCode: u.warehouseCode || 'DXB-FC1',
            warehouseName: u.warehouseName || 'Dubai Fulfillment Center 1',
            authMode: 'supabase-pgcrypto',
          };

          failedAttemptsRef.current = { count: 0, lockedUntil: 0 };
          persistSession(sessionUser);
          return true;
        }
      } catch {
        // Network unreachable -> gracefully fall back to local PBKDF2-SHA256 edge verification
      }
    }

    // 2. Offline Edge Fallback via Web Crypto PBKDF2-SHA256
    const allUsers = await db.users.toArray();
    const found = allUsers.find((u) => u.username.toLowerCase() === cleanUser.toLowerCase());

    if (found && found.id != null) {
      const valid = await verifyPasswordLocal(password, found.password);
      if (valid) {
        const sessionUser: AuthUser = {
          id: found.id,
          username: found.username,
          role: found.role,
          displayName: found.displayName,
          tenantCode: WMS_TENANT_CODE,
          warehouseCode: 'DXB-FC1',
          authMode: 'edge-pbkdf2',
        };
        failedAttemptsRef.current = { count: 0, lockedUntil: 0 };
        persistSession(sessionUser);
        await logAction('LOGIN', `User ${found.username} logged in (Edge PBKDF2)`, found.displayName);
        return true;
      }
    }

    failedAttemptsRef.current.count += 1;
    if (failedAttemptsRef.current.count >= MAX_FAILED_ATTEMPTS) {
      failedAttemptsRef.current.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    return false;
  }, []);

  const updateUser = useCallback((updates: Partial<AuthUser>) => {
    setUser((prev) => {
      if (!prev) return null;
      const updated = { ...prev, ...updates };
      const stored = localStorage.getItem('vortex_session');
      if (stored) {
        try {
          const session = JSON.parse(stored);
          session.user = updated;
          localStorage.setItem('vortex_session', JSON.stringify(session));
        } catch {
          // ignore
        }
      }
      return updated;
    });
  }, []);

  const can = useCallback(
    (permission: string) => hasPermission(user?.role, permission),
    [user?.role]
  );

  const contextValue = React.useMemo<AuthContextType>(
    () => ({
      user,
      login,
      logout,
      isAdmin: user?.role === 'admin',
      isSupervisor: user?.role === 'admin' || user?.role === 'supervisor',
      can,
      loading,
      updateUser,
    }),
    [user, loading, login, logout, can, updateUser]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
