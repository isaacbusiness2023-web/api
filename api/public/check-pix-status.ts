import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/check-pix-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = process.env.PIX_GATEWAY_URL_ENCRYPTED;
        if (!url) {
          return Response.json({ error: "gateway_not_configured" }, { status: 500 });
        }

        let body: { transaction_id?: string; transactionId?: string };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        const transactionId = (body.transaction_id ?? body.transactionId ?? "").trim();
        if (!transactionId) {
          return Response.json({ error: "missing_transaction_id" }, { status: 400 });
        }

        const target = `${url}?transactionId=${encodeURIComponent(transactionId)}`;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(target, { method: "GET", signal: controller.signal });
          clearTimeout(timeout);
          const data = (await res.json().catch(() => ({}))) as {
            status?: string;
            paidAt?: string;
          };
          const completed = (data?.status ?? "").toUpperCase() === "COMPLETED";
          return Response.json({
            status: completed ? "paid" : "pending",
            paid_at: data?.paidAt ?? null,
          });
        } catch (e) {
          console.error("[PIX] status failed", (e as Error).message, "url=", url.slice(-8));
          return Response.json({ status: "pending" });
        }
      },
    },
  },
});
