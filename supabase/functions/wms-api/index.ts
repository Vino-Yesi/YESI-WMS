import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-warehouse-code, x-idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = performance.now();
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const action = url.searchParams.get("action") || "health";
    const warehouseCode = req.headers.get("x-warehouse-code") || url.searchParams.get("warehouse") || "DXB-FC1";

    if (req.method === "GET" && action === "health") {
      const { data: kpis, error } = await supabase
        .from("v_wms_kpi_summary")
        .select("*")
        .eq("warehouse_code", warehouseCode)
        .maybeSingle();

      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      return new Response(
        JSON.stringify({
          status: error ? "degraded" : "healthy",
          service: "yesi-wms-edge-api",
          version: "2.0.0",
          warehouse: warehouseCode,
          latency_ms: latencyMs,
          timestamp: new Date().toISOString(),
          kpis: kpis || null,
          error: error?.message || null,
        }),
        { status: error ? 503 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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

    if (req.method === "POST") {
      const body = await req.json();
      const op = body.action || action;

      if (op === "flush_outbox") {
        const { data: pending } = await supabase
          .from("wms_event_outbox")
          .select("id")
          .eq("status", "pending")
          .limit(100);

        const ids = (pending || []).map((p: { id: string }) => p.id);
        if (ids.length > 0) {
          await supabase
            .from("wms_event_outbox")
            .update({ status: "published", published_at: new Date().toISOString() })
            .in("id", ids);
        }
        return new Response(
          JSON.stringify({ ok: true, published_count: ids.length }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (op === "webhook_order") {
        const { data: wh } = await supabase
          .from("wms_warehouses")
          .select("id, tenant_id")
          .eq("code", warehouseCode)
          .maybeSingle();

        if (!wh) throw new Error(`Warehouse ${warehouseCode} not found`);

        const eventId = body.event_id || crypto.randomUUID();
        await supabase.from("wms_webhook_inbox").upsert({
          tenant_id: wh.tenant_id,
          source: body.source || "marketplace",
          event_id: eventId,
          event_type: body.event_type || "ORDER_CREATED",
          payload: body,
          status: "processed",
          processed_at: new Date().toISOString(),
        });

        if (body.order_number && body.required_skus) {
          await supabase.from("wms_sales_orders").upsert(
            {
              tenant_id: wh.tenant_id,
              warehouse_id: wh.id,
              order_number: body.order_number,
              posting_number: body.posting_number || body.order_number,
              channel: body.channel || "ozon",
              status: "Pending",
              priority: body.priority || "normal",
              required_skus: body.required_skus,
              total_amount: Number(body.total_amount || 0),
              carrier_name: body.carrier_name || "GBS Express",
              tracking_number: body.tracking_number || body.order_number,
            },
            { onConflict: "warehouse_id,order_number" },
          );
        }

        return new Response(
          JSON.stringify({ ok: true, event_id: eventId }),
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
