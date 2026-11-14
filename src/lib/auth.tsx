import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { db, logAction } from './db';

interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'supervisor';
  displayName: string;
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAdmin: boolean;
  loading: boolean;
  updateUser: (updates: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => false,
  logout: () => {},
  isAdmin: false,
  loading: true,
  updateUser: () => {},
});

const SESSION_TIMEOUT_MINUTES = 30;

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
  const userRef = useRef(user);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const logout = useCallback(() => {
    const current = userRef.current;
    if (current) {
      logAction('LOGOUT', `User ${current.username} logged out`, current.displayName);
    }
    localStorage.removeItem('vortex_session');
    setUser(null);
  }, []);

  // Session timeout enforcement
  useEffect(() => {
    if (!user) return;

    const checkTimeout = () => {
      const inactive = Date.now() - lastActivity;
      if (inactive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
        logout();
      }
    };

    const interval = setInterval(checkTimeout, 60000); // check every minute

    const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    const updateActivity = () => setLastActivity(Date.now());
    activityEvents.forEach(e => window.addEventListener(e, updateActivity));

    return () => {
      clearInterval(interval);
      activityEvents.forEach(e => window.removeEventListener(e, updateActivity));
    };
  }, [user, lastActivity, logout]);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    const found = await db.users
      .where('username').equals(username)
      .filter(u => u.password === password)
      .first();

    if (found && found.id) {
      const sessionUser: AuthUser = {
        id: found.id,
        username: found.username,
        role: found.role,
        displayName: found.displayName,
      };

      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + SESSION_TIMEOUT_MINUTES);

      localStorage.setItem('vortex_session', JSON.stringify({
        user: sessionUser,
        expiresAt: expiresAt.toISOString(),
      }));

      setUser(sessionUser);
      setLastActivity(Date.now());
      await logAction('LOGIN', `User ${username} logged in`, found.displayName);
      return true;
    }
    return false;
  }, []);

  const updateUser = useCallback((updates: Partial<AuthUser>) => {
    setUser(prev => {
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

  // Memoize the context value: the provider re-renders on every user activity
  // heartbeat (mousedown/scroll/keydown), and an inline object here would give
  // the value a new identity each time, re-rendering every useAuth() consumer.
  const contextValue = React.useMemo<AuthContextType>(
    () => ({
      user,
      login,
      logout,
      isAdmin: user?.role === 'admin',
      loading,
      updateUser,
    }),
    [user, loading, login, logout, updateUser]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
