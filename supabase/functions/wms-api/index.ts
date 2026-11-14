import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function buildCorsHeaders(origin: string | null) {
  const allowedList = (Deno.env.get("WMS_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    allowedList.length === 0
      ? origin || "*"
      : origin && allowedList.includes(origin)
        ? origin
        : allowedList[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-tenant-code, x-warehouse-code, x-session-token, x-webhook-secret, x-idempotency-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const corsHeaders = buildCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = performance.now();
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Edge runtime missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const action = url.searchParams.get("action") || "health";
    const tenantCode = (req.headers.get("x-tenant-code") || url.searchParams.get("tenant") || "").trim();
    const warehouseCode = (req.headers.get("x-warehouse-code") || url.searchParams.get("warehouse") || "").trim();
    const sessionToken = (req.headers.get("x-session-token") || "").trim();

    // 1. Health Endpoint (validates warehouse if supplied)
    if (req.method === "GET" && action === "health") {
      if (!warehouseCode) {
        return new Response(
          JSON.stringify({
            status: "healthy",
            service: "yesi-wms-edge-api",
            version: "2.1.0",
            warehouse: "UNSCOPED",
            latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
            timestamp: new Date().toISOString(),
            kpis: null,
            error: null,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: kpis, error } = await supabase
        .from("v_wms_kpi_summary")
        .select("*")
        .eq("warehouse_code", warehouseCode)
        .maybeSingle();

      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      return new Response(
        JSON.stringify({
          status: error || !kpis ? "degraded" : "healthy",
          service: "yesi-wms-edge-api",
          version: "2.1.0",
          warehouse: warehouseCode,
          latency_ms: latencyMs,
          timestamp: new Date().toISOString(),
          kpis: kpis || null,
          error: error?.message || (!kpis ? `Warehouse ${warehouseCode} not found` : null),
        }),
        { status: error ? 503 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Prometheus OpenMetrics Endpoint
    if (req.method === "GET" && action === "metrics") {
      const { data: rows } = await supabase.from("v_wms_kpi_summary").select("*");
      const lines: string[] = [
        "# HELP wms_inventory_on_hand_units Current physical stock on hand per warehouse",
        "# TYPE wms_inventory_on_hand_units gauge",
        "# HELP wms_inventory_available_units Unreserved allocatable stock per warehouse",
        "# TYPE wms_inventory_available_units gauge",
        "# HELP wms_orders_open_total Open fulfillment orders in pipeline",
        "# TYPE wms_orders_open_total gauge",
        "# HELP wms_orders_shipped_total Dispatched orders count",
        "# TYPE wms_orders_shipped_total counter",
        "# HELP wms_outbox_pending_events Unconfirmed transactional outbox events",
        "# TYPE wms_outbox_pending_events gauge",
      ];
      for (const r of rows || []) {
        const wh = r.warehouse_code;
        lines.push(`wms_inventory_on_hand_units{warehouse="${wh}"} ${r.total_on_hand ?? 0}`);
        lines.push(`wms_inventory_available_units{warehouse="${wh}"} ${r.total_available ?? 0}`);
        lines.push(`wms_orders_open_total{warehouse="${wh}"} ${r.open_orders ?? 0}`);
        lines.push(`wms_orders_shipped_total{warehouse="${wh}"} ${r.shipped_orders ?? 0}`);
        lines.push(`wms_outbox_pending_events{warehouse="${wh}"} ${r.outbox_pending ?? 0}`);
      }
      return new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain; version=0.0.4" },
      });
    }

    // 3. Mutating POST Operations — Require Strict Tenant, Warehouse, and Auth/Webhook Validation
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return new Response(
          JSON.stringify({ ok: false, error: "INVALID_JSON_PAYLOAD" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const op = String(body.action || action || "").trim();
      const effectiveTenant = String(body.tenant_code || tenantCode || "").trim();
      const effectiveWarehouse = String(body.warehouse_code || warehouseCode || "").trim();

      if (!effectiveTenant || !effectiveWarehouse) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "SCOPE_REQUIRED: Both tenant_code (x-tenant-code) and warehouse_code (x-warehouse-code) are mandatory on mutating API calls",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Verify tenant + warehouse ownership
      const { data: tenantRow } = await supabase
        .from("wms_tenants")
        .select("id, code, status")
        .eq("code", effectiveTenant)
        .eq("status", "active")
        .maybeSingle();

      if (!tenantRow) {
        return new Response(
          JSON.stringify({ ok: false, error: `TENANT_INVALID: ${effectiveTenant}` }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: whRow } = await supabase
        .from("wms_warehouses")
        .select("id, tenant_id, code, status")
        .eq("tenant_id", tenantRow.id)
        .eq("code", effectiveWarehouse)
        .eq("status", "active")
        .maybeSingle();

      if (!whRow) {
        return new Response(
          JSON.stringify({ ok: false, error: `WAREHOUSE_INVALID: ${effectiveWarehouse} not active under ${effectiveTenant}` }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (op === "flush_outbox") {
        if (!sessionToken) {
          return new Response(
            JSON.stringify({ ok: false, error: "AUTH_REQUIRED: Signed x-session-token required for flush_outbox" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const { data: sessCheck, error: sessErr } = await supabase.rpc("wms_validate_session", {
          p_session_token: sessionToken,
          p_tenant_code: effectiveTenant,
          p_warehouse_code: effectiveWarehouse,
        });

        if (sessErr || !sessCheck?.valid) {
          return new Response(
            JSON.stringify({ ok: false, error: sessCheck?.error || "SESSION_INVALID" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const userRole = sessCheck.user?.role;
        if (!["admin", "supervisor", "operator"].includes(userRole)) {
          return new Response(
            JSON.stringify({ ok: false, error: `PERMISSION_DENIED: Role ${userRole} cannot flush outbox` }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const { data: pending } = await supabase
          .from("wms_event_outbox")
          .select("id")
          .eq("tenant_id", tenantRow.id)
          .eq("warehouse_id", whRow.id)
          .eq("status", "pending")
          .limit(100);

        const ids = (pending || []).map((p: { id: string }) => p.id);
        if (ids.length > 0) {
          await supabase
            .from("wms_event_outbox")
            .update({ status: "published", published_at: new Date().toISOString() })
            .in("id", ids);
        }

        await supabase.from("wms_audit_logs").insert({
          tenant_id: tenantRow.id,
          warehouse_id: whRow.id,
          operator_name: sessCheck.user?.username || "api",
          action: "OUTBOX_FLUSHED",
          entity_type: "wms_event_outbox",
          details: `Published ${ids.length} pending events`,
        });

        return new Response(
          JSON.stringify({ ok: true, published_count: ids.length, warehouse: effectiveWarehouse }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (op === "webhook_order") {
        const expectedSecret = Deno.env.get("WMS_WEBHOOK_SECRET");
        const providedSecret = req.headers.get("x-webhook-secret") || "";

        // Require either a valid webhook secret OR a valid supervisor/admin session token
        let authorizedActor = String(body.source || "marketplace");
        if (expectedSecret) {
          if (providedSecret !== expectedSecret) {
            return new Response(
              JSON.stringify({ ok: false, error: "WEBHOOK_UNAUTHORIZED: Invalid x-webhook-secret" }),
              { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        } else if (sessionToken) {
          const { data: sessCheck } = await supabase.rpc("wms_validate_session", {
            p_session_token: sessionToken,
            p_tenant_code: effectiveTenant,
            p_warehouse_code: effectiveWarehouse,
          });
          if (!sessCheck?.valid || !["admin", "supervisor"].includes(sessCheck.user?.role)) {
            return new Response(
              JSON.stringify({ ok: false, error: "WEBHOOK_FORBIDDEN: Valid supervisor/admin session required" }),
              { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          authorizedActor = sessCheck.user.username;
        } else {
          return new Response(
            JSON.stringify({ ok: false, error: "WEBHOOK_AUTH_REQUIRED: Supply x-webhook-secret or x-session-token" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const orderNumber = String(body.order_number || "").trim();
        const requiredSkus = String(body.required_skus || "").trim();
        if (!orderNumber || !requiredSkus) {
          return new Response(
            JSON.stringify({ ok: false, error: "VALIDATION_ERROR: order_number and required_skus are required" }),
            { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const eventId = String(req.headers.get("x-idempotency-key") || body.event_id || `ord:${effectiveWarehouse}:${orderNumber}`);

        await supabase.from("wms_webhook_inbox").upsert(
          {
            tenant_id: tenantRow.id,
            source: authorizedActor,
            event_id: eventId,
            event_type: String(body.event_type || "ORDER_CREATED"),
            payload: body,
            status: "processed",
            processed_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,source,event_id" },
        );

        await supabase.from("wms_sales_orders").upsert(
          {
            tenant_id: tenantRow.id,
            warehouse_id: whRow.id,
            order_number: orderNumber,
            posting_number: String(body.posting_number || orderNumber),
            channel: String(body.channel || "ozon"),
            status: "Pending",
            priority: ["urgent", "high", "normal", "low"].includes(String(body.priority)) ? body.priority : "normal",
            required_skus: requiredSkus,
            total_amount: Math.max(0, Number(body.total_amount || 0)),
            carrier_name: String(body.carrier_name || "GBS Express"),
            tracking_number: String(body.tracking_number || orderNumber),
          },
          { onConflict: "warehouse_id,order_number" },
        );

        await supabase.from("wms_audit_logs").insert({
          tenant_id: tenantRow.id,
          warehouse_id: whRow.id,
          operator_name: authorizedActor,
          action: "WEBHOOK_ORDER_INGESTED",
          entity_type: "wms_sales_orders",
          entity_id: orderNumber,
          details: `Ingested order ${orderNumber} (${requiredSkus})`,
        });

        return new Response(
          JSON.stringify({ ok: true, event_id: eventId, order_number: orderNumber }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(
      JSON.stringify({ ok: false, error: `Unsupported action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
