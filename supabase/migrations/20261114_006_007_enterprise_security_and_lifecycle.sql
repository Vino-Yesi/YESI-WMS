-- ============================================================================
-- Migration 006 & 007: Enterprise Session Security, Account Lockout, Strict
-- Tenant/Warehouse Validation, and Multi-Stage Fulfillment Lifecycle Checkpoints
-- ============================================================================
-- Mirrors live Supabase PostgreSQL 17 migrations applied to YESI-WMS:
--   - wms_user_sessions (SHA-256 hashed server session tokens, RLS service_role only)
--   - wms_users.failed_login_attempts, locked_until, allowed_warehouses
--   - wms_assert_context(p_tenant_code, p_warehouse_code, p_session_token, p_required_roles)
--   - wms_authenticate_user_v2 (progressive exponential lockout + signed token)
--   - wms_validate_session & wms_revoke_session
--   - wms_receive_inbound_grn (stages into QC Hold or Directed Putaway Queue)
--   - wms_release_qc_hold (Supervisor/Admin approval checkpoint -> Directed Putaway)
--   - wms_complete_putaway_task (verifies QC passed -> increments allocatable bin stock)
--   - wms_confirm_order_packed (verifies Pick -> transitions order to Packed)
--   - wms_dispatch_order (enforces Packed/ReadyToShip gate -> atomic ledger deduction)
--   - wms_process_return_rma (quarantine / restock / supervisor scrap disposition)
-- ============================================================================

ALTER TABLE public.wms_users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allowed_warehouses TEXT[] NOT NULL DEFAULT ARRAY['DXB-FC1', 'MSK-HUB2']::TEXT[];

CREATE TABLE IF NOT EXISTS public.wms_user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.wms_tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.wms_users(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.wms_warehouses(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wms_user_sessions ENABLE ROW LEVEL SECURITY;
