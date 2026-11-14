import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/lib/auth';
import { seedDatabase } from '@/lib/db';
import { startHybridSyncEngine } from '@/lib/supabaseSync';
import { useEffect, useState, Suspense, lazy, type ComponentType } from 'react';
import Layout from '@/components/Layout';
import OfflineIndicator from '@/components/OfflineIndicator';
import InstallPrompt from '@/components/InstallPrompt';
import CommandPalette from '@/components/CommandPalette';
import AIAssistant from '@/components/AIAssistant';
import { RouteErrorBoundary } from '@/components/ErrorBoundary';
import Login from '@/pages/Login';

// Core & Executive
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const DailyManual = lazy(() => import('@/pages/DailyManual'));
const WorkflowSummary = lazy(() => import('@/pages/WorkflowSummary'));
const CloudMonitor = lazy(() => import('@/pages/CloudMonitor'));
const GuardianDashboard = lazy(() => import('@/pages/GuardianDashboard'));

// Inbound Domain (04)
const DockManagement = lazy(() => import('@/pages/DockManagement'));
const InboundReceiving = lazy(() => import('@/pages/InboundReceiving'));
const QCManagement = lazy(() => import('@/pages/QCManagement'));
const PutawayManagement = lazy(() => import('@/pages/PutawayManagement'));

// Inventory & Location Domains (02, 03, 05, 07)
const InventoryHub = lazy(() => import('@/pages/InventoryHub'));
const SerialTracking = lazy(() => import('@/pages/SerialTracking'));
const CycleCount = lazy(() => import('@/pages/CycleCount'));
const Replenishment = lazy(() => import('@/pages/Replenishment'));
const LocationBarcodeGenerator = lazy(() => import('@/pages/LocationBarcodeGenerator'));
const BarcodeScanner = lazy(() => import('@/pages/BarcodeScanner'));

// Outbound, Transport & Returns Domains (06, 08, 09)
const PickPack = lazy(() => import('@/pages/PickPack'));
const BatchPickCenter = lazy(() => import('@/pages/BatchPickCenter'));
const Shipping = lazy(() => import('@/pages/Shipping'));
const PostingTracker = lazy(() => import('@/pages/PostingTracker'));
const Returns = lazy(() => import('@/pages/Returns'));

// Label, Floor Tools, Integrations, Labor & Admin (10, 11, 12)
const PDFSequencer = lazy(() => import('@/pages/PDFSequencer'));
const Templates = lazy(() => import('@/pages/Templates'));
const BulkConverter = lazy(() => import('@/pages/BulkConverter'));
const Auditor = lazy(() => import('@/pages/Auditor'));
const SIMManager = lazy(() => import('@/pages/SIMManager'));
const GSheetHub = lazy(() => import('@/pages/GSheetHub'));
const OzonSheetsHub = lazy(() => import('@/pages/OzonSheetsHub'));
const IntegrationHub = lazy(() => import('@/pages/IntegrationHub'));
const LaborManagement = lazy(() => import('@/pages/LaborManagement'));
const Analytics = lazy(() => import('@/pages/Analytics'));
const Memory = lazy(() => import('@/pages/Memory'));
const UserManagement = lazy(() => import('@/pages/UserManagement'));
const Settings = lazy(() => import('@/pages/Settings'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="w-7 h-7 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function LazyPage({ component: C, title }: { component: ComponentType; title?: string }) {
  return (
    <RouteErrorBoundary title={title}>
      <Suspense fallback={<PageLoader />}>
        <C />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-void">
        <div className="w-8 h-8 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Control Tower & Instant Wave */}
        <Route index element={<LazyPage component={Dashboard} title="Control Tower Dashboard" />} />
        <Route path="dashboard" element={<LazyPage component={Dashboard} title="Control Tower Dashboard" />} />
        <Route path="daily" element={<LazyPage component={DailyManual} title="Daily Instant Fulfillment" />} />
        <Route path="workflow" element={<LazyPage component={WorkflowSummary} title="Fulfillment Workflow Blueprint" />} />
        <Route path="cloud" element={<LazyPage component={CloudMonitor} title="Cloud Core & Telemetry" />} />
        <Route path="guardian" element={<LazyPage component={GuardianDashboard} title="Guardian Ops Center" />} />

        {/* Inbound Operations (Domain 04) */}
        <Route path="dock" element={<LazyPage component={DockManagement} title="Dock Scheduling & ASN" />} />
        <Route path="inbound" element={<LazyPage component={InboundReceiving} title="Inbound Receiving & GRN" />} />
        <Route path="qc" element={<LazyPage component={QCManagement} title="Quality Inspection & Holds" />} />
        <Route path="putaway" element={<LazyPage component={PutawayManagement} title="Directed Putaway" />} />

        {/* Inventory & Location Control (Domains 02, 03, 05, 07) */}
        <Route path="inventory" element={<LazyPage component={InventoryHub} title="Inventory Hub & Oracle" />} />
        <Route path="serial-tracking" element={<LazyPage component={SerialTracking} title="Serial & IMEI Traceability" />} />
        <Route path="cycle-count" element={<LazyPage component={CycleCount} title="ABC Cycle Counting" />} />
        <Route path="replenishment" element={<LazyPage component={Replenishment} title="Min/Max Replenishment" />} />
        <Route path="barcode-generator" element={<LazyPage component={LocationBarcodeGenerator} title="Location & SKU Barcodes" />} />
        <Route path="barcode-scanner" element={<LazyPage component={BarcodeScanner} title="RF / Camera Scanner" />} />

        {/* Outbound, Transport & Returns (Domains 06, 08, 09) */}
        <Route path="pick-pack" element={<LazyPage component={PickPack} title="Pick & Pack Station" />} />
        <Route path="batch-pick" element={<LazyPage component={BatchPickCenter} title="Wave & Batch Pick Center" />} />
        <Route path="shipping" element={<LazyPage component={Shipping} title="Carrier Dispatch & Manifest" />} />
        <Route path="posting" element={<LazyPage component={PostingTracker} title="Proof-of-Dispatch Tracker" />} />
        <Route path="returns" element={<LazyPage component={Returns} title="RMA & Returns Disposition" />} />

        {/* Floor Utilities, Integrations & Administration (Domains 10, 11, 12) */}
        <Route path="pdf-sequencer" element={<LazyPage component={PDFSequencer} title="PDF Label Sequencer" />} />
        <Route path="templates" element={<LazyPage component={Templates} title="SKU Mapping Templates" />} />
        <Route path="bulk-convert" element={<LazyPage component={BulkConverter} title="Bulk Data Converter" />} />
        <Route path="auditor" element={<LazyPage component={Auditor} title="Pack & Weight Auditor" />} />
        <Route path="sim-manager" element={<LazyPage component={SIMManager} title="SIM / IMEI TAC Registry" />} />
        <Route path="gsheet" element={<LazyPage component={GSheetHub} title="Daily G-Sheet Tracker" />} />
        <Route path="ozon-sheets" element={<LazyPage component={OzonSheetsHub} title="Ozon Live Sheet Pipeline" />} />
        <Route path="integrations" element={<LazyPage component={IntegrationHub} title="ERP / OMS Integration Hub" />} />
        <Route path="labor" element={<LazyPage component={LaborManagement} title="Labor & UPH Management" />} />
        <Route path="analytics" element={<LazyPage component={Analytics} title="Operational Analytics & KPIs" />} />
        <Route path="memory" element={<LazyPage component={Memory} title="Warehouse Rules & Aliases" />} />
        <Route path="users" element={<LazyPage component={UserManagement} title="RBAC User & Audit Management" />} />
        <Route path="settings" element={<LazyPage component={Settings} title="System Settings" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stopSync: (() => void) | null = null;
    seedDatabase().then(() => {
      setReady(true);
      stopSync = startHybridSyncEngine();
    });
    return () => {
      stopSync?.();
    };
  }, []);

  if (!ready) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <div className="w-10 h-10 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <AuthProvider>
      <RouteErrorBoundary title="Application Error">
        <OfflineIndicator />
        <InstallPrompt />
        <CommandPalette />
        <AIAssistant />
        <AppRoutes />
      </RouteErrorBoundary>
    </AuthProvider>
  );
}
