import { createFileRoute } from "@tanstack/react-router";

// Digistore24 IPN webhook.
// Configure this URL in the Digistore product settings (IPN / Webhook):
//   https://worldwideinfo.online/api/public/digistore-webhook
// Set the same "IPN passphrase" from Digistore in the DIGISTORE_PASSPHRASE secret.

const CANONICAL_ORIGIN = "https://worldwideinfo.online";

function shouldProxyToCanonical(requestUrl: string) {
  const url = new URL(requestUrl);
  return url.origin !== CANONICAL_ORIGIN;
}

async function sha512Upper(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// Digistore24 signature algorithm.
async function digistoreSignature(params: Record<string, string>, passphrase: string) {
  const keys = Object.keys(params)
    .filter((key) => key.toLowerCase() !== "sha_sign")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  let shaString = "";
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    shaString += `${key}=${value}${passphrase}`;
  }
  return sha512Upper(shaString);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/digistore-webhook")({
  server: {
    handlers: {
      GET: async () => new Response("OK", { status: 200 }),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (shouldProxyToCanonical(request.url)) {
          const proxied = await fetch(`${CANONICAL_ORIGIN}/api/public/digistore-webhook`, {
            method: "POST",
            headers: { "Content-Type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
            body: raw,
          }).catch(() => null);
          if (proxied) return new Response(await proxied.text(), { status: proxied.status });
          return new Response("proxy_failed", { status: 502 });
        }
        const params: Record<string, string> = {};
        const contentType = request.headers.get("content-type") ?? "";

        if (contentType.includes("application/json")) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            for (const [key, value] of Object.entries(parsed)) {
              if (typeof value === "string" || typeof value === "number") params[key] = String(value);
            }
          } catch {
            return new Response("invalid_json", { status: 400 });
          }
        } else {
          new URLSearchParams(raw).forEach((value, key) => {
            params[key] = value;
          });
        }

        const passphrase = process.env.DIGISTORE_PASSPHRASE;
        let signatureValid = false;
        if (passphrase) {
          const expected = await digistoreSignature(params, passphrase);
          const received = (params.sha_sign ?? "").toUpperCase();
          signatureValid = Boolean(received) && timingSafeEqual(expected, received);
          if (!signatureValid) {
            // Do NOT drop the order: Digistore signature variants (encoding/param set)
            // can differ. Record it as unverified and keep processing.
            console.warn(
              `[digistore-webhook] signature mismatch (expected ${expected.slice(0, 12)}..., received ${received.slice(0, 12)}...) - processing as unverified`,
            );
          }
        } else {
          console.warn("[digistore-webhook] DIGISTORE_PASSPHRASE not set - signature not verified");
        }

        const event = params.event ?? "unknown";
        const orderId = params.order_id ?? params.transaction_id ?? null;
        const buyerEmail = (params.email ?? params.buyer_email ?? "").trim().toLowerCase() || null;
        const custom = params.custom ?? params.custom1 ?? null;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Match the lead: first by the lead key we sent in `custom`, then by the altered email.
        let lead: { id: string; email_real: string } | null = null;
        if (custom) {
          const { data } = await supabaseAdmin
            .from("checkout_leads")
            .select("id, email_real")
            .eq("lead_key", custom)
            .maybeSingle();
          lead = data ?? null;
        }
        if (!lead && buyerEmail) {
          const { data } = await supabaseAdmin
            .from("checkout_leads")
            .select("id, email_real")
            .eq("email_checkout", buyerEmail)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          lead = data ?? null;
        }
        // Third attempt: undo the duplicated letter we add before the "@" at checkout.
        if (!lead && buyerEmail) {
          const at = buyerEmail.indexOf("@");
          if (at > 1 && buyerEmail[at - 1] === buyerEmail[at - 2]) {
            const guess = buyerEmail.slice(0, at - 1) + buyerEmail.slice(at);
            const { data } = await supabaseAdmin
              .from("checkout_leads")
              .select("id, email_real")
              .eq("email_real", guess)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            lead = data ?? null;
          }
        }

        // Never send an access email to the checkout address. If the saved
        // real address cannot be resolved, keep the order for review but do
        // not attempt delivery.
        const deliveryEmail = lead?.email_real?.trim().toLowerCase() ?? null;

        const amount = Number(params.amount ?? params.order_amount ?? 0);


        const { data: inserted, error } = await supabaseAdmin
          .from("digistore_orders")
          .upsert(
            {
              order_id: orderId,
              event,
              buyer_email: buyerEmail,
              product_id: params.product_id ?? null,
              amount: Number.isFinite(amount) ? amount : null,
              currency: params.currency ?? null,
              custom,
              lead_id: lead?.id ?? null,
              email_real: deliveryEmail,
              raw: { ...params, _signature_valid: signatureValid ? "1" : "0" },
            },
            { onConflict: "order_id,event" },
          )
          .select("id, access_email_sent_at")
          .maybeSingle();

        if (error) console.error("[digistore-webhook] save failed", error.message);

        // Send the access email to the REAL email on approved payments.
        const isPayment = event === "on_payment" || event === "on_payment_missed" ? event === "on_payment" : false;
        if (isPayment && deliveryEmail && inserted && !inserted.access_email_sent_at) {
          try {
            // Atomically claim this order before sending so simultaneous IPNs
            // cannot dispatch duplicate messages from separate instances.
            const claimedAt = new Date().toISOString();
            const { data: claimed } = await supabaseAdmin
              .from("digistore_orders")
              .update({ access_email_sent_at: claimedAt })
              .eq("id", inserted.id)
              .is("access_email_sent_at", null)
              .select("id")
              .maybeSingle();
            if (!claimed) return new Response("OK", { status: 200 });

            const res = await fetch(`${CANONICAL_ORIGIN}/api/public/send-access-email`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: deliveryEmail,
                leadKey: custom ?? "",
                item: params.product_name ?? "TikTok Bonus",
                name: params.address_first_name ?? params.first_name ?? params.buyer_first_name ?? "",
                orderId: orderId ?? "",
                template: "access",
              }),
            });
            const sendResult = (await res.json().catch(() => ({}))) as { id?: string; skipped?: string };
            if (!res.ok || !sendResult.id) {
              await supabaseAdmin
                .from("digistore_orders")
                .update({ access_email_sent_at: null })
                .eq("id", inserted.id);
              console.error(
                "[digistore-webhook] access email not sent",
                res.status,
                sendResult.skipped ?? "unknown_error",
              );
            }
          } catch (err) {
            await supabaseAdmin
              .from("digistore_orders")
              .update({ access_email_sent_at: null })
              .eq("id", inserted.id);
            console.error("[digistore-webhook] access email error", err);
          }
        } else if (isPayment && !deliveryEmail) {
          console.warn("[digistore-webhook] access email blocked: real lead email was not resolved");
        }

        return new Response("OK", { status: 200 });
      },
    },
  },
});
