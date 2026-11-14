import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';

const FALLBACK_SUPABASE_URL = 'https://xtbbnnwthhngapmxqyis.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_ifExJmWE1FUV3hj968_Yzw_0Hr1ubJD';

export const SUPABASE_URL: string =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || FALLBACK_SUPABASE_URL;

export const SUPABASE_ANON_KEY: string =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || FALLBACK_SUPABASE_ANON_KEY;

export const WMS_TENANT_CODE: string =
  (import.meta.env.VITE_WMS_TENANT_CODE as string | undefined)?.trim() || 'YESI-FZCO';

export const WMS_DEFAULT_WAREHOUSE: string =
  (import.meta.env.VITE_WMS_DEFAULT_WAREHOUSE as string | undefined)?.trim() || 'DXB-FC1';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'yesi-wms-supabase-auth',
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

export interface WmsKpiSummaryRow {
  tenant_id: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  active_skus: number;
  total_on_hand: number;
  total_reserved: number;
  total_available: number;
  low_stock_skus: number;
  open_orders: number;
  shipped_orders: number;
  open_pick_tasks: number;
  open_putaway_tasks: number;
  active_qc_holds: number;
  total_returns: number;
  outbox_pending: number;
}

export interface WmsEdgeHealthResponse {
  status: 'healthy' | 'degraded' | 'offline';
  service: string;
  version: string;
  warehouse: string;
  latency_ms: number;
  timestamp: string;
  kpis: WmsKpiSummaryRow | null;
  error: string | null;
}

export async function checkEdgeGatewayHealth(warehouseCode = WMS_DEFAULT_WAREHOUSE): Promise<WmsEdgeHealthResponse> {
  const started = performance.now();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/wms-api?action=health&warehouse=${encodeURIComponent(warehouseCode)}`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          'x-warehouse-code': warehouseCode,
        },
      }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as WmsEdgeHealthResponse;
    return json;
  } catch (err) {
    return {
      status: 'offline',
      service: 'yesi-wms-edge-api',
      version: '2.0.0',
      warehouse: warehouseCode,
      latency_ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
      kpis: null,
      error: err instanceof Error ? err.message : 'Network unreachable',
    };
  }
}

export async function flushCloudOutbox(): Promise<{ ok: boolean; published_count: number }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/wms-api?action=flush_outbox`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'flush_outbox' }),
    });
    if (!res.ok) return { ok: false, published_count: 0 };
    return (await res.json()) as { ok: boolean; published_count: number };
  } catch {
    return { ok: false, published_count: 0 };
  }
}

export function subscribeWmsRealtime(onTableChange: (table: string, eventType: string) => void): () => void {
  let channel: RealtimeChannel | null = null;
  try {
    channel = supabase
      .channel('wms-floor-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_inventory_balances' },
        (payload) => onTableChange('wms_inventory_balances', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_sales_orders' },
        (payload) => onTableChange('wms_sales_orders', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_pick_tasks' },
        (payload) => onTableChange('wms_pick_tasks', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_putaway_tasks' },
        (payload) => onTableChange('wms_putaway_tasks', payload.eventType)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wms_shipments' },
        (payload) => onTableChange('wms_shipments', payload.eventType)
      )
      .subscribe();
  } catch {
    // Offline fallback — ignore subscription error
  }

  return () => {
    if (channel) {
      supabase.removeChannel(channel);
    }
  };
}
