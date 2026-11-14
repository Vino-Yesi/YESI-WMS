import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/lib/store';
import {
  LayoutDashboard,
  Package,
  PackageOpen,
  RotateCcw,
  ScanBarcode,
  Scale,
  RefreshCw,
  Settings,
  Users,
  LogOut,
  Hexagon,
  BarChart3,
  ClipboardCheck,
  Zap,
  ShieldCheck,
  FileText,
  Brain,
  Smartphone,
  Shield,
  X,
  Camera,
  QrCode,
  Barcode,
  Truck,
  Plug,
  ArrowDownToLine,
  Fingerprint,
  Layers,
  UsersRound,
  Bot,
  Sheet,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  AlertTriangle,
  Link2,
} from 'lucide-react';

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

type NavItem = {
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  short: string;
  aiTrigger?: boolean;
  adminOnly?: boolean;
};

// YESI Lite WMS — day-to-day instant order modules (no G-Sheet / Posting Tracker)
const operationItems: NavItem[] = [
  { icon: LayoutDashboard, label: 'Daily Manual', path: '/', short: 'Day' },
  { icon: Link2, label: 'G-Sheets', path: '/gsheet', short: 'Sheet' },
  { icon: Layers, label: 'Batch Pick', path: '/batch-pick', short: 'Batch' },
  { icon: Truck, label: 'Shipping', path: '/shipping', short: 'Ship' },
];

const advancedItems: NavItem[] = [
  { icon: ClipboardCheck, label: 'Inventory', path: '/inventory', short: 'Inv' },
  { icon: Fingerprint, label: 'Serials', path: '/serial-tracking', short: 'SN' },
  { icon: BarChart3, label: 'Analytics', path: '/analytics', short: 'KPI' },
  { icon: Barcode, label: 'Barcodes', path: '/barcode-generator', short: 'BC' },
];

const manualOrderItems: NavItem[] = [
  { icon: ScanBarcode, label: 'PDF Seq', path: '/pdf-sequencer', short: 'PDF' },
  { icon: FileText, label: 'Templates', path: '/templates', short: 'Tpl' },
  { icon: RefreshCw, label: 'Bulk Convert', path: '/bulk-convert', short: 'Bulk' },
  { icon: Scale, label: 'Auditor', path: '/auditor', short: 'Aud' },
  { icon: Smartphone, label: 'SIM / IMEI', path: '/sim-manager', short: 'SIM' },
];

const adminItems: NavItem[] = [
  { icon: Users, label: 'Users', path: '/users', short: 'Usr', adminOnly: true },
];

export default function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, logout } = useAuth();
    const density = useAppStore((s) => s.density);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleSidebarCollapsed);

  const compact = density === 'compact';
  const itemPad = compact ? 'px-2 py-1.5' : 'px-3 py-2.5';
  const gap = compact ? 'gap-2' : 'gap-3';
  const sectionGap = compact ? 'space-y-0.5' : 'space-y-1';
  const iconSize = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const textSize = compact ? 'text-xs' : 'text-sm';
  const sectionLabel = compact ? 'text-[9px] px-2 mb-1' : 'text-[10px] px-3 mb-2';

  const handleNav = (path: string, _aiTrigger?: boolean) => {
    navigate(path);
    onClose?.();
  };

  const sidebarBaseStyle = {
    background: '#0c0c0e',
  };

  const renderNavItems = (items: NavItem[]) =>
    items
      .filter((item) => !item.adminOnly || isAdmin)
      .map((item) => {
        const isActive = !item.aiTrigger && location.pathname === item.path;
        return (
          <button
            key={item.path}
            onClick={() => handleNav(item.path, item.aiTrigger)}
            title={collapsed ? item.label : undefined}
            className={`relative w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} transition-all duration-150 group ${
              collapsed ? 'justify-center' : ''
            }`}
            style={
              isActive
                ? {
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.2)',
                  }
                : { border: '1px solid transparent' }
            }
          >
            {isActive && !collapsed && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-accent-sky rounded-r-full" />
            )}
            <item.icon className={`${iconSize} shrink-0 ${isActive ? 'text-accent-sky' : 'text-white/50 group-hover:text-white'}`} />
            {!collapsed && (
              <span className={`font-medium truncate ${isActive ? 'text-white' : 'text-text-secondary group-hover:text-white'}`}>
                {compact ? item.short : item.label}
              </span>
            )}
          </button>
        );
      });

  const desktopWidth = collapsed ? 'w-[56px]' : compact ? 'w-[168px]' : 'w-[220px]';
  const mainMargin = collapsed ? 'lg:ml-[56px]' : compact ? 'lg:ml-[168px]' : 'lg:ml-[220px]';

  // Expose margin class via data attribute for Layout
  const asideContent = (isMobile: boolean) => (
    <>
      {/* Logo / collapse toggle */}
      <div className={`flex items-center ${collapsed && !isMobile ? 'justify-center px-1' : 'gap-2 px-3'} ${compact ? 'py-3' : 'py-4'} border-b border-white/[0.06]`}>
        <div
          className={`${compact ? 'w-7 h-7' : 'w-8 h-8'} rounded-md flex items-center justify-center shrink-0 bg-sky-500`}
        >
          <Hexagon className={compact ? 'w-3.5 h-3.5 text-white' : 'w-4 h-4 text-white'} />
        </div>
        {(!collapsed || isMobile) && (
          <div className="min-w-0 flex-1">
            <h1 className={`${compact ? 'text-[11px]' : 'text-xs'} font-bold text-white tracking-tight truncate`}>YESI</h1>
            <p className="text-[9px] text-white/35 uppercase tracking-wider truncate">Fulfillment</p>
          </div>
        )}
        {!isMobile && (
          <button
            onClick={toggleCollapsed}
            className="p-1 rounded text-white/40 hover:text-white hover:bg-white/5 transition-colors shrink-0"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
        )}
        {isMobile && (
          <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav className={`flex-1 overflow-y-auto ${compact ? 'px-1.5 py-2' : 'px-2 py-3'} ${sectionGap}`}>
        {operationItems.length > 0 && (
          <>
            {(!collapsed || isMobile) && (
              <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium`}>Ops</div>
            )}
            <div className={sectionGap}>{renderNavItems(operationItems)}</div>
          </>
        )}

        {advancedItems.length > 0 && (
          <>
            {(!collapsed || isMobile) && (
              <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>Hub</div>
            )}
            <div className={sectionGap}>{renderNavItems(advancedItems)}</div>
          </>
        )}

        {manualOrderItems.length > 0 && (
          <>
            {(!collapsed || isMobile) && (
              <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>Tools</div>
            )}
            <div className={sectionGap}>{renderNavItems(manualOrderItems)}</div>
          </>
        )}

        {adminItems.length > 0 && (
          <>
            {(!collapsed || isMobile) && (
              <div className={`${sectionLabel} text-white/30 uppercase tracking-widest font-medium mt-3`}>Admin</div>
            )}
            <div className={sectionGap}>{renderNavItems(adminItems)}</div>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className={`border-t border-white/[0.06] ${compact ? 'p-1.5' : 'p-2'} ${sectionGap}`}>
        <button
          onClick={() => handleNav('/settings')}
          className={`w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} text-text-secondary hover:text-white hover:bg-white/5 transition-colors ${
            collapsed && !isMobile ? 'justify-center' : ''
          }`}
          title="Settings"
        >
          <Settings className={`${iconSize} shrink-0`} />
          {(!collapsed || isMobile) && <span className="font-medium">Settings</span>}
        </button>
        <button
          onClick={() => { logout(); onClose?.(); }}
          className={`w-full flex items-center ${gap} ${itemPad} rounded-lg ${textSize} text-accent-red/80 hover:text-accent-red hover:bg-accent-red/10 transition-colors ${
            collapsed && !isMobile ? 'justify-center' : ''
          }`}
          title="Sign out"
        >
          <LogOut className={`${iconSize} shrink-0`} />
          {(!collapsed || isMobile) && <span className="font-medium">Sign out</span>}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop */}
      <aside
        className={`hidden lg:flex fixed left-0 top-0 h-full ${desktopWidth} border-r border-white/[0.06] flex-col z-50 transition-[width] duration-200`}
        style={sidebarBaseStyle}
        data-sidebar-width={collapsed ? 56 : compact ? 168 : 220}
      >
        {asideContent(false)}
      </aside>

      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-40 lg:hidden"
              onClick={onClose}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              className="fixed left-0 top-0 h-full w-[240px] border-r border-white/[0.06] flex flex-col z-50 lg:hidden"
              style={sidebarBaseStyle}
            >
              {asideContent(true)}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

/** Hook-friendly width token for Layout margin */
export function useSidebarWidthPx(): number {
  const density = useAppStore((s) => s.density);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  if (collapsed) return 56;
  return density === 'compact' ? 168 : 220;
}
