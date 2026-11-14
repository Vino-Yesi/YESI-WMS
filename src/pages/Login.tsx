import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { Eye, EyeOff, Hexagon, Sparkles, Shield, Zap, Package } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

function Starfield() {
  const stars = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => ({
        id: i,
        x: ((i * 37) % 97) + 1.5,
        y: ((i * 53) % 95) + 2,
        r: ((i % 5) * 0.3) + 0.5,
        d: (i % 4) + 2.5,
        delay: (i % 7) * 0.6,
        o: ((i % 5) * 0.1) + 0.25,
      })),
    []
  );

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {stars.map((s) => (
        <motion.span
          key={s.id}
          className="absolute rounded-full bg-white"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.r,
            height: s.r,
            opacity: s.o,
          }}
          animate={{ opacity: [s.o * 0.3, s.o, s.o * 0.3], scale: [1, 1.4, 1] }}
          transition={{ duration: s.d, delay: s.delay, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
    </div>
  );
}

function AuroraOrbs() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <motion.div
        className="absolute -top-32 -left-32 w-[28rem] h-[28rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.22) 0%, transparent 70%)' }}
        animate={{ x: [0, 40, 0], y: [0, 30, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute top-1/3 -right-24 w-[24rem] h-[24rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%)' }}
        animate={{ x: [0, -30, 0], y: [0, 50, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-24 left-1/3 w-[22rem] h-[22rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(16,185,129,0.12) 0%, transparent 70%)' }}
        animate={{ scale: [1, 1.15, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}

function GridOverlay() {
  return (
    <div
      className="absolute inset-0 pointer-events-none opacity-[0.07]"
      style={{
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
        maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
      }}
    />
  );
}

const FEATURES = [
  { icon: Package, label: 'Instant fulfill' },
  { icon: Shield, label: 'Scan audit' },
  { icon: Zap, label: 'Neural ops' },
  { icon: Sparkles, label: 'Adaptation' },
];

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [focusField, setFocusField] = useState<'user' | 'pass' | null>(null);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const success = await login(username.trim(), password);
      if (!success) {
        setError('Invalid credentials. Check username and password.');
        setShake(true);
        setTimeout(() => setShake(false), 500);
      } else {
        navigate('/', { replace: true });
      }
    } catch {
      setError('Login failed. Please try again.');
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden bg-black text-white">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#030308]" />
      <AuroraOrbs />
      <GridOverlay />
      <Starfield />
      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 70% 40%, transparent 0%, rgba(0,0,0,0.55) 70%), linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.7) 100%)',
        }}
      />

      {/* Brand — bottom left */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6 }}
        className="absolute bottom-8 left-8 z-10 hidden sm:block max-w-sm"
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)',
              boxShadow: '0 0 32px rgba(56,189,248,0.35)',
            }}
          >
            <Hexagon className="w-6 h-6 text-white" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-lg font-bold tracking-tight">Yesi-WMS Lite</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Warehouse Management</div>
          </div>
        </div>
        <p className="text-xs text-white/45 leading-relaxed">
          Instant posting, scan validation, adaptation &amp; neural ops — offline-first fulfillment for the floor.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 + i * 0.1 }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-[10px] text-white/60"
            >
              <f.icon className="w-3 h-3 text-sky-400" />
              {f.label}
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Login card */}
      <div className="relative z-10 flex min-h-[100dvh] items-center justify-center p-4 sm:justify-end sm:pr-[8%] lg:pr-[12%]">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[400px]"
        >
          <motion.div
            animate={shake ? { x: [0, -10, 10, -8, 8, 0] } : { x: 0 }}
            transition={{ duration: 0.45 }}
            className="relative rounded-3xl p-px"
            style={{
              background:
                focusField
                  ? 'linear-gradient(135deg, rgba(56,189,248,0.55), rgba(139,92,246,0.35), rgba(56,189,248,0.2))'
                  : 'linear-gradient(135deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04), rgba(255,255,255,0.1))',
              boxShadow: focusField
                ? '0 0 60px rgba(56,189,248,0.15), 0 24px 48px rgba(0,0,0,0.5)'
                : '0 24px 48px rgba(0,0,0,0.45)',
            }}
          >
            <div
              className="rounded-[23px] px-7 py-8 sm:px-8 sm:py-9 backdrop-blur-2xl"
              style={{
                background:
                  'linear-gradient(165deg, rgba(18,18,24,0.92) 0%, rgba(8,8,12,0.96) 100%)',
              }}
            >
              {/* Logo mark */}
              <div className="flex flex-col items-center mb-7">
                <motion.div
                  className="relative mb-4"
                  animate={{ rotate: [0, 4, -4, 0] }}
                  transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <div
                    className="absolute inset-0 rounded-2xl blur-xl opacity-60"
                    style={{ background: 'linear-gradient(135deg, #38bdf8, #8b5cf6)' }}
                  />
                  <div
                    className="relative w-14 h-14 rounded-2xl flex items-center justify-center"
                    style={{
                      background: 'linear-gradient(145deg, #38bdf8 0%, #3b82f6 50%, #6366f1 100%)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)',
                    }}
                  >
                    <Hexagon className="w-7 h-7 text-white drop-shadow" strokeWidth={2.25} />
                  </div>
                </motion.div>
                <h1 className="text-xl font-semibold tracking-tight">Yesi-WMS Lite</h1>
                <p className="text-xs text-white/40 mt-1 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-sky-400/80" />
                  Sign in to your warehouse floor
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-medium ml-0.5">
                    Username
                  </label>
                  <div
                    className={`mt-1.5 relative rounded-xl transition-all duration-300 ${
                      focusField === 'user' ? 'ring-1 ring-sky-400/40' : ''
                    }`}
                  >
                    <input
                      type="text"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onFocus={() => setFocusField('user')}
                      onBlur={() => setFocusField(null)}
                      placeholder="admin"
                      className="w-full rounded-xl bg-white/[0.04] border border-white/[0.08] px-4 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-sky-400/40 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-medium ml-0.5">
                    Password
                  </label>
                  <div
                    className={`mt-1.5 relative rounded-xl transition-all duration-300 ${
                      focusField === 'pass' ? 'ring-1 ring-sky-400/40' : ''
                    }`}
                  >
                    <input
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={() => setFocusField('pass')}
                      onBlur={() => setFocusField(null)}
                      placeholder="••••••••"
                      className="w-full rounded-xl bg-white/[0.04] border border-white/[0.08] px-4 py-3 pr-11 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-sky-400/40 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors p-1"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2"
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>

                <motion.button
                  type="submit"
                  disabled={loading || !username || !password}
                  whileHover={{ scale: loading ? 1 : 1.015 }}
                  whileTap={{ scale: 0.98 }}
                  className="group relative w-full py-3.5 rounded-xl font-semibold text-sm text-white overflow-hidden disabled:opacity-40 disabled:cursor-not-allowed mt-1"
                  style={{
                    background: 'linear-gradient(135deg, #38bdf8 0%, #3b82f6 45%, #6366f1 100%)',
                    boxShadow: '0 8px 28px rgba(56,189,248,0.28), inset 0 1px 0 rgba(255,255,255,0.2)',
                  }}
                >
                  <span
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    style={{
                      background:
                        'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.18) 50%, transparent 60%)',
                      backgroundSize: '200% 100%',
                    }}
                  />
                  <span className="relative flex items-center justify-center gap-2">
                    {loading ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Authenticating…
                      </>
                    ) : (
                      'Sign in'
                    )}
                  </span>
                </motion.button>
              </form>

              <div className="mt-6 pt-5 border-t border-white/[0.06]">
                <p className="text-[10px] text-center text-white/25 font-mono tracking-wide">
                  <span className="text-sky-400/60">YESI-FZCO</span>
                  <span className="mx-2 text-white/15">·</span>
                  Warehouse Fulfillment Tool
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
