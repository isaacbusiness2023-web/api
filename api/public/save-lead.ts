import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

const CANONICAL_ORIGIN = "https://worldwideinfo.online";

type Body = {
  email_real?: string;
  email_checkout?: string;
  lead_key?: string;
  params?: Record<string, string>;
  page?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function shouldProxyToCanonical(requestUrl: string) {
  const url = new URL(requestUrl);
  return url.origin !== CANONICAL_ORIGIN && !process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function isCanonicalRequest(requestUrl: string) {
  return new URL(requestUrl).origin === CANONICAL_ORIGIN;
}

async function proxyToCanonical(body: Body) {
  return fetch(`${CANONICAL_ORIGIN}/api/public/save-lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function proxyJsonToCanonical(body: Body) {
  const proxied = await proxyToCanonical(body).catch(() => null);
  if (!proxied) return json({ error: "save_failed" }, 502);
  return json(await proxied.json().catch(() => ({ ok: proxied.ok })), proxied.ok ? 200 : proxied.status);
}

export const Route = createFileRoute("/api/public/save-lead")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }

        const emailReal = (body.email_real ?? "").trim().toLowerCase();
        const emailCheckout = (body.email_checkout ?? "").trim().toLowerCase();
        const leadKey = (body.lead_key ?? "").trim().slice(0, 64);

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailReal)) {
          return json({ error: "invalid_email" }, 400);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCheckout)) {
          return json({ error: "invalid_checkout_email" }, 400);
        }
        if (!/^[a-zA-Z0-9_-]{6,64}$/.test(leadKey)) {
          return json({ error: "invalid_lead_key" }, 400);
        }

        if (shouldProxyToCanonical(request.url)) {
          return proxyJsonToCanonical(body);
        }

        const params: Record<string, string> = {};
        if (body.params && typeof body.params === "object") {
          for (const [key, value] of Object.entries(body.params).slice(0, 40)) {
            if (typeof value === "string") params[key.slice(0, 60)] = value.slice(0, 500);
          }
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { error } = await supabaseAdmin.from("checkout_leads").upsert(
            {
              lead_key: leadKey,
              email_real: emailReal,
              email_checkout: emailCheckout,
              params,
              page: (body.page ?? "").slice(0, 300) || null,
              user_agent: (request.headers.get("user-agent") ?? "").slice(0, 400) || null,
            },
            { onConflict: "lead_key" },
          );
          if (error) {
            console.error("[save-lead] insert failed", error.message);
            if (!isCanonicalRequest(request.url)) return proxyJsonToCanonical(body);
            return json({ error: "save_failed" }, 500);
          }
        } catch (err) {
          console.error("[save-lead] unexpected", err);
          if (!isCanonicalRequest(request.url)) return proxyJsonToCanonical(body);
          return json({ error: "save_failed" }, 500);
        }

        return json({ ok: true, lead_key: leadKey });
      },
    },
  },
});
