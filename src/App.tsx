import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/lib/auth';
import { seedDatabase } from '@/lib/db';
import { useEffect, useState, Suspense, lazy, type ComponentType } from 'react';
import Layout from '@/components/Layout';
import OfflineIndicator from '@/components/OfflineIndicator';
import InstallPrompt from '@/components/InstallPrompt';
import { RouteErrorBoundary } from '@/components/ErrorBoundary';
import Login from '@/pages/Login';

const DailyManual = lazy(() => import('@/pages/DailyManual'));
const InventoryHub = lazy(() => import('@/pages/InventoryHub'));
const SerialTracking = lazy(() => import('@/pages/SerialTracking'));
const BatchPickCenter = lazy(() => import('@/pages/BatchPickCenter'));
const Shipping = lazy(() => import('@/pages/Shipping'));
const LocationBarcodeGenerator = lazy(() => import('@/pages/LocationBarcodeGenerator'));
const PDFSequencer = lazy(() => import('@/pages/PDFSequencer'));
const Templates = lazy(() => import('@/pages/Templates'));
const SIMManager = lazy(() => import('@/pages/SIMManager'));
const Analytics = lazy(() => import('@/pages/Analytics'));
const Settings = lazy(() => import('@/pages/Settings'));
const BulkConverter = lazy(() => import('@/pages/BulkConverter'));
const Auditor = lazy(() => import('@/pages/Auditor'));
const UserManagement = lazy(() => import('@/pages/UserManagement'));
const GSheetHub = lazy(() => import('@/pages/GSheetHub'));

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
      <Suspense fallback={<PageLoader />}><C /></Suspense>
    </RouteErrorBoundary>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="fixed inset-0 flex items-center justify-center bg-void"><div className="w-8 h-8 border-2 border-accent-sky border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<LazyPage component={DailyManual} title="Daily Manual" />} />
        <Route path="daily" element={<LazyPage component={DailyManual} title="Daily Manual" />} />
        <Route path="inventory" element={<LazyPage component={InventoryHub} title="Inventory Hub" />} />
        <Route path="serial-tracking" element={<LazyPage component={SerialTracking} title="Serial Tracking" />} />
        <Route path="batch-pick" element={<LazyPage component={BatchPickCenter} title="Batch Pick" />} />
        <Route path="shipping" element={<LazyPage component={Shipping} title="Shipping" />} />
        <Route path="barcode-generator" element={<LazyPage component={LocationBarcodeGenerator} title="Barcode Generator" />} />
        <Route path="pdf-sequencer" element={<LazyPage component={PDFSequencer} title="PDF Sequencer" />} />
        <Route path="templates" element={<LazyPage component={Templates} title="Templates" />} />
        <Route path="sim-manager" element={<LazyPage component={SIMManager} title="SIM Manager" />} />
        <Route path="analytics" element={<LazyPage component={Analytics} title="Analytics" />} />
        <Route path="bulk-convert" element={<LazyPage component={BulkConverter} title="Bulk Converter" />} />
        <Route path="auditor" element={<LazyPage component={Auditor} title="Auditor" />} />
        <Route path="users" element={<LazyPage component={UserManagement} title="User Management" />} />
        <Route path="gsheet" element={<LazyPage component={GSheetHub} title="G-Sheet links" />} />
        <Route path="settings" element={<LazyPage component={Settings} title="Settings" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => { seedDatabase().then(() => setReady(true)); }, []);
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
        <AppRoutes />
      </RouteErrorBoundary>
    </AuthProvider>
  );
}
