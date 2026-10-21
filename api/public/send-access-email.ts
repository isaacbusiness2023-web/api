import { createFileRoute } from "@tanstack/react-router";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
const RESEND_API_URL = "https://api.resend.com";
const CANONICAL_ORIGIN = "https://worldwideinfo.online";

type EmailTemplate = "access" | "email_3" | "email_6" | "email_consistency" | "email_42";

type AccessEmailBody = {
  balance?: number;
  count?: number;
  email?: string;
  item?: string;
  leadKey?: string;
  name?: string;
  orderId?: string;
  template?: EmailTemplate;
};

type RecipientResolution =
  | { ok: true; email: string }
  | { ok: false; reason: "checkout_alias_unmapped" | "lead_lookup_failed" | "order_not_found" | "order_without_real_email" };

const FROM = "Bonus Access <access@access.orbitagram.com>";
const DASHBOARD_URL = "https://taskpartners.live/tasks-app";
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const recentSends = new Map<string, number>();

export const Route = createFileRoute("/api/public/send-access-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const lovableKey = process.env.LOVABLE_API_KEY;
        const resendKey = process.env.RESEND_API_KEY;
        // Chave direta da Resend (funciona fora do Lovable, ex.: Vercel)
        const directKey = process.env.RESEND_DIRECT_API_KEY || (resendKey?.startsWith("re_") ? resendKey : undefined);
        const rawBody = await request.text();
        const requestOrigin = new URL(request.url).origin;
        // All sends must go through the canonical deployment, where the lead
        // database is available. A deployment with only a Resend key must
        // never send before resolving the real address.
        if (requestOrigin !== CANONICAL_ORIGIN) {
          const proxied = await fetch(`${CANONICAL_ORIGIN}/api/public/send-access-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: rawBody,
          }).catch(() => null);
          if (proxied) {
            return Response.json(await proxied.json().catch(() => ({ ok: proxied.ok })), { status: proxied.status });
          }
          return Response.json({ error: "canonical_email_service_unavailable" }, { status: 502 });
        }
        if (!directKey && (!lovableKey || !resendKey)) {
          return Response.json({ error: "resend_not_configured" }, { status: 500 });
        }

        let body: AccessEmailBody;
        try {
          body = JSON.parse(rawBody) as AccessEmailBody;
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        const rawEmail = (body.email ?? "").trim().toLowerCase();
        const firstName = (body.name ?? "").trim().split(/\s+/)[0] || "there";

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
          return Response.json({ error: "invalid_email" }, { status: 400 });
        }

        const templateName = body.template ?? "access";
        const orderId = (body.orderId ?? "").trim();
        const resolution = templateName === "access"
          ? await resolveApprovedOrderEmail(orderId, (body.leadKey ?? "").trim())
          : await resolveRealEmail(rawEmail);
        if (!resolution.ok) {
          console.warn(`[send-access-email] blocked unresolved recipient: ${resolution.reason}`);
          return Response.json({ ok: true, skipped: resolution.reason });
        }
        const email = resolution.email;

        const dedupeKey = `${templateName}|${email}|${orderId}`;
        const now = Date.now();
        for (const [key, ts] of recentSends) if (now - ts > DEDUPE_WINDOW_MS) recentSends.delete(key);
        if (recentSends.has(dedupeKey)) {
          return Response.json({ ok: true, skipped: "duplicate" });
        }




        const template = buildEmailTemplate({
          balance: Number(body.balance ?? 0),
          count: Number(body.count ?? 0),
          firstName,
          item: (body.item ?? "").trim(),
          orderId: (body.orderId ?? "").trim(),
          template: templateName,
        });

        const payload = JSON.stringify({
          from: FROM,
          html: template.html,
          subject: template.subject,
          to: [email],
        });

        const send = (url: string, headers: Record<string, string>) =>
          fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload });

        let res: Response | null = null;

        // 1) Caminho independente do Lovable: API oficial da Resend
        if (directKey) {
          res = await send(`${RESEND_API_URL}/emails`, { Authorization: `Bearer ${directKey}` }).catch(() => null);
        }

        // 2) Fallback: gateway do Lovable
        if ((!res || !res.ok) && lovableKey && resendKey) {
          const gw = await send(`${GATEWAY_URL}/emails`, {
            Authorization: `Bearer ${lovableKey}`,
            "X-Connection-Api-Key": resendKey,
          }).catch(() => null);
          if (gw) res = gw;
        }

        if (!res) {
          return Response.json({ error: "email_send_failed" }, { status: 502 });
        }

        const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (!res.ok) {
          console.error("[Resend] send failed", res.status, data?.message ?? "");
          return Response.json({ error: "email_send_failed" }, { status: 502 });
        }

        recentSends.set(dedupeKey, Date.now());
        return Response.json({ ok: true, id: data.id ?? null });
      },
    },
  },
});

function buildEmailTemplate(props: {
  balance: number;
  count: number;
  firstName: string;
  item?: string;
  orderId?: string;
  template: EmailTemplate;
}) {
  const firstName = escapeHtml(props.firstName);
  const balance = usd(props.balance || 0);

  if (props.template === "email_3") {
    return {
      subject: "Activity Sync Detected",
      html: emailShell({
        body: `
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Our system detected your first activity sync after 3 completed creator audits. This confirms that your reviewer profile is active and progressing through the verification cycle.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#475569;">Your account activity has been synchronized successfully. Available balance status: <strong>${balance}</strong> toward the $4,000.00 withdrawal threshold.</p>
        `,
        title: "Activity Sync Detected",
      }),
    };
  }

  if (props.template === "email_6") {
    return {
      subject: "Daily Quota Completed",
      html: emailShell({
        body: `
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Your first daily audit quota has been completed successfully. This helps maintain account quality, review accuracy, and secure payout eligibility.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#475569;">Today&apos;s account activity has been recorded. Please return on the next cycle to continue releasing your pending balance.</p>
        `,
        title: "Daily Quota Completed",
      }),
    };
  }

  if (props.template === "email_consistency") {
    return {
      subject: "Excellent Consistency",
      html: emailShell({
        body: `
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Excellent consistency. Your account has reached another verified audit milestone, and your activity pattern remains aligned with creator partner review requirements.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#475569;">Your reviewer profile remains in good standing. Continue the available daily audit cycle to keep releasing pending balance toward the $4,000.00 threshold.</p>
        `,
        title: "Excellent Consistency",
      }),
    };
  }

  if (props.template === "email_42") {
    return {
      subject: "Verification Milestone Achieved",
      html: emailShell({
        body: `
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Your verification milestone has been completed. This indicates that the required creator audit activity has been recorded on your reviewer profile.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#475569;">Please open your dashboard to review the current withdrawal status and confirm your payout details.</p>
        `,
        title: "Verification Milestone Achieved",
      }),
    };
  }

  const orderId = escapeHtml(props.orderId || "");
  const item = escapeHtml(props.item || "TikTok Bonus");

  return {
    subject: orderId ? `Order ${orderId} — your access details` : "Your access details",
    html: orderEmail({ firstName, item, orderId }),
  };
}

function orderEmail({ firstName, item, orderId }: { firstName: string; item: string; orderId: string }) {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:0 24px 8px 0;font-size:16px;line-height:1.6;color:#6b7280;">${label}</td>
      <td style="padding:0 0 8px;font-size:16px;line-height:1.6;color:#111827;">${value}</td>
    </tr>`;

  return `
    <div style="margin:0;background:#ffffff;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:560px;margin:0 auto;">
        <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">Hi ${firstName},</p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Thanks for your order. Your access details are below.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 28px;">
          ${orderId ? row("Order", orderId) : ""}
          ${row("Item", item)}
        </table>
        <a href="${DASHBOARD_URL}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;border-radius:6px;padding:16px 26px;margin:0 0 28px;">
          Open your order
        </a>
        <p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#6b7280;">Or paste this into your browser:</p>
        <p style="margin:0 0 26px;font-size:15px;line-height:1.6;"><a href="${DASHBOARD_URL}" style="color:#1a73e8;">${DASHBOARD_URL}</a></p>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#111827;">Reply to this email if you need any help with your order.</p>
      </div>
    </div>
  `;
}

function emailShell({ body, title }: { body: string; title: string }) {
  return `
    <div style="margin:0;background:#f8fafc;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <div style="padding:28px 24px;background:#010101;color:#ffffff;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#25F4EE;">Task Partners</p>
          <h1 style="margin:0;font-size:28px;line-height:1.15;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:26px 24px;">
          ${body}
          <a href="${DASHBOARD_URL}" style="display:block;text-align:center;background:#FE2C55;color:#ffffff;text-decoration:none;font-weight:800;border-radius:8px;padding:15px 18px;margin:24px 0;">
            Open My Dashboard
          </a>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">This is an automated account notification from Task Partners Support.</p>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char] ?? char;
  });
}

function usd(value: number) {
  return value.toLocaleString("en-US", { currency: "USD", style: "currency" });
}

// Resolve against the stored lead. If the database is unavailable or an
// altered checkout address cannot be mapped, block the send instead of
// falling back to the untrusted address.
async function resolveRealEmail(email: string): Promise<RecipientResolution> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: byCheckout } = await supabaseAdmin
      .from("checkout_leads")
      .select("email_real")
      .eq("email_checkout", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byCheckout?.email_real) return { ok: true, email: byCheckout.email_real.trim().toLowerCase() };

    const { data: byReal } = await supabaseAdmin
      .from("checkout_leads")
      .select("email_real")
      .eq("email_real", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byReal?.email_real) return { ok: true, email: byReal.email_real.trim().toLowerCase() };

    const at = email.indexOf("@");
    if (at > 1 && email[at - 1] === email[at - 2]) {
      const guess = email.slice(0, at - 1) + email.slice(at);
      const { data: byGuess } = await supabaseAdmin
        .from("checkout_leads")
        .select("email_real")
        .eq("email_real", guess)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byGuess?.email_real) return { ok: true, email: byGuess.email_real.trim().toLowerCase() };
      return { ok: false, reason: "checkout_alias_unmapped" };
    }
  } catch (err) {
    console.warn("[send-access-email] lead lookup failed", err);
    return { ok: false, reason: "lead_lookup_failed" };
  }
  // Behavioral emails originate from an authenticated app profile and may
  // predate checkout. Access/order sends, however, are only issued for saved
  // checkout leads and therefore never reach this fallback in normal use.
  return { ok: true, email };
}

async function resolveApprovedOrderEmail(orderId: string, leadKey: string): Promise<RecipientResolution> {
  if (!orderId) return { ok: false, reason: "order_not_found" };

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: order, error } = await supabaseAdmin
      .from("digistore_orders")
      .select("email_real")
      .eq("order_id", orderId)
      .eq("event", "on_payment")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[send-access-email] approved order lookup failed", error.message);
      return { ok: false, reason: "lead_lookup_failed" };
    }

    const email = order?.email_real?.trim().toLowerCase();
    if (!order) return { ok: false, reason: "order_not_found" };
    if (!email) return { ok: false, reason: "order_without_real_email" };

    // Access emails are anchored to the unique key created by the popup.
    // This prevents a checkout alias or an address edited in Digistore from
    // ever becoming the recipient, including when the funnel runs on Vercel.
    if (leadKey) {
      const { data: lead, error: leadError } = await supabaseAdmin
        .from("checkout_leads")
        .select("email_real")
        .eq("lead_key", leadKey)
        .maybeSingle();
      if (leadError) return { ok: false, reason: "lead_lookup_failed" };
      const leadEmail = lead?.email_real?.trim().toLowerCase();
      if (!leadEmail || leadEmail !== email) {
        return { ok: false, reason: "order_without_real_email" };
      }
      return { ok: true, email: leadEmail };
    }
    return { ok: true, email };
  } catch (err) {
    console.warn("[send-access-email] approved order lookup failed", err);
    return { ok: false, reason: "lead_lookup_failed" };
  }
}
