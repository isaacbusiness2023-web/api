import { createFileRoute } from "@tanstack/react-router";

type CreateBody = {
  value?: number;
  amount?: number;
  customer?: {
    name?: string;
    email?: string;
    document?: string;
    phone?: string;
  };
  utm?: string;
  item?: { title?: string; price?: number; quantity?: number };
};

const digits = (s: string | undefined | null) => (s ?? "").replace(/\D/g, "");

async function postWithRetry(url: string, body: unknown) {
  const delays = [1000, 2000, 4000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status >= 500) {
        lastErr = new Error(`Gateway ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  throw lastErr ?? new Error("Gateway unavailable");
}

export const Route = createFileRoute("/api/public/create-pix-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = process.env.PIX_GATEWAY_URL_ENCRYPTED;
        if (!url) {
          return Response.json({ error: "gateway_not_configured" }, { status: 500 });
        }

        let body: CreateBody;
        try {
          body = (await request.json()) as CreateBody;
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        const amount = Number(body.value ?? body.amount ?? 0);
        const c = body.customer ?? {};
        const name = (c.name ?? "").trim();
        const document = digits(c.document);
        const phone = digits(c.phone);
        const email = (c.email ?? "").trim().toLowerCase();

        if (!amount || amount < 100) {
          return Response.json({ error: "invalid_amount" }, { status: 400 });
        }
        if (!name || !email || (document.length !== 11 && document.length !== 14) || (phone.length !== 10 && phone.length !== 11)) {
          return Response.json({ error: "invalid_customer" }, { status: 400 });
        }

        const payload = {
          amount,
          customer: { name, document, email, phone },
          item: {
            title: body.item?.title || "TikTok Reward",
            price: body.item?.price ?? amount,
            quantity: body.item?.quantity ?? 1,
          },
          paymentMethod: "PIX" as const,
          ...(body.utm ? { utm: body.utm } : {}),
        };

        try {
          const res = await postWithRetry(url, payload);
          const data = (await res.json()) as {
            pixCode?: string;
            transactionId?: string;
            status?: string;
            message?: string;
          };
          if (!res.ok || !data?.pixCode || !data?.transactionId) {
            console.error("[PIX] gateway error", res.status, data?.message ?? "", "url=", url.slice(-8));
            return Response.json({ error: "gateway_error" }, { status: 502 });
          }
          return Response.json({
            id: data.transactionId,
            qr_code: data.pixCode,
            qr_code_base64: "",
            status: data.status ?? "PENDING",
          });
        } catch (e) {
          console.error("[PIX] create failed", (e as Error).message, "url=", url.slice(-8));
          return Response.json({ error: "gateway_unreachable" }, { status: 502 });
        }
      },
    },
  },
});
