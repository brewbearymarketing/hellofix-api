import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

/* ================= CONFIG ================= */
export const config = {
  api: {
    bodyParser: false
  }
};

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16"
});

/* ================= RAW BODY (NO MICRO) ================= */
async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/* ================= SEND WHATSAPP ================= */
async function sendWhatsApp(phone_number: string, message: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"

  if (!accountSid || !authToken || !from) {
    console.error("❌ Twilio env vars missing");
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const body = new URLSearchParams({
    From: from,
    To: `whatsapp:${phone_number}`,
    Body: message
  });

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

/* ================= API HANDLER ================= */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).json({ ignored: true });
  }

  let event: Stripe.Event;

  try {
    const sig = req.headers["stripe-signature"] as string;
    const rawBody = await readRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Stripe signature failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  /* ================= ACCEPT ONLY PAID CHECKOUT ================= */
  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ ignored: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== "paid") {
    return res.status(200).json({ ignored: true });
  }

  const gateway_payment_id = session.payment_intent as string;
  const ticket_id = session.metadata?.ticket_id;
  const amount = (session.amount_total ?? 0) / 100;

  if (!ticket_id || !gateway_payment_id) {
    return res.status(200).json({ ignored: true });
  }

  try {
    /* ================= IDEMPOTENCY ================= */
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("gateway_payment_id", gateway_payment_id)
      .maybeSingle();

    if (existing) {
      // ⚠️ DO NOT SEND WHATSAPP AGAIN
      return res.status(200).json({ ok: true, duplicate: true });
    }

    /* ================= LOAD TICKET ================= */
    const { data: ticket } = await supabase
      .from("tickets")
      .select("id, condo_id, phone_number, language")
      .eq("id", ticket_id)
      .maybeSingle();

    if (!ticket) {
      return res.status(200).json({ ok: true });
    }

    /* ================= INSERT PAYMENT ================= */
    await supabase.from("payments").insert({
      ticket_id: ticket.id,
      gateway_payment_id,
      amount,
      currency: "MYR",
      status: "paid",
      provider: "stripe",
      payment_type: "diagnosis"
    });

    /* ================= UPDATE TICKET ================= */
    await supabase
      .from("tickets")
      .update({
        status: "paid",
        updated_at: new Date()
      })
      .eq("id", ticket.id);

    /* ================= UPDATE CONVERSATION ================= */
    await supabase
      .from("conversation_sessions")
      .update({
        state: "contractor_assignment",
        updated_at: new Date()
      })
      .eq("condo_id", ticket.condo_id)
      .eq("phone_number", ticket.phone_number);

    /* ================= SEND WHATSAPP (ONLY HERE) ================= */
    await sendWhatsApp(
      ticket.phone_number,
      ticket.language === "ms"
        ? "✅ Pembayaran berjaya diterima.\n\nKontraktor sedang ditugaskan. Anda akan dimaklumkan melalui WhatsApp."
        : ticket.language === "zh"
        ? "✅ 付款成功。\n\n正在分配承包商，您将通过 WhatsApp 收到通知。"
        : ticket.language === "ta"
        ? "✅ கட்டணம் பெறப்பட்டது.\n\nஒப்பந்ததாரர் நியமிக்கப்படுகிறார்."
        : "✅ Payment received.\n\nA contractor is being assigned. You will be notified via WhatsApp."
    );

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("🔥 PAYMENT WEBHOOK ERROR (non-fatal):", err);
    // IMPORTANT: never return 500
    return res.status(200).json({ ok: true });
  }
}
