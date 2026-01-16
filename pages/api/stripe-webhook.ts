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

/* ================= RAW BODY ================= */
async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/* ================= WHATSAPP ================= */
async function sendWhatsApp(phone: string, message: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!sid || !token || !from) {
    console.error("❌ Twilio env missing");
    return;
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        From: from,
        To: `whatsapp:${phone}`,
        Body: message
      })
    }
  );
}

/* ================= LANGUAGE COPY ================= */
function paymentSuccessText(lang: string) {
  switch (lang) {
    case "ms":
      return (
        "✅ Pembayaran berjaya diterima.\n\n" +
        "Kontraktor sedang ditugaskan.\n" +
        "Anda akan dimaklumkan melalui WhatsApp sebelum lawatan."
      );
    case "zh":
      return (
        "✅ 付款成功。\n\n" +
        "承包商正在分配中。\n" +
        "我们将通过 WhatsApp 通知您。"
      );
    case "ta":
      return (
        "✅ கட்டணம் வெற்றிகரமாக பெறப்பட்டது.\n\n" +
        "ஒப்பந்ததாரர் நியமிக்கப்படுகிறார்.\n" +
        "WhatsApp மூலம் தகவல் வழங்கப்படும்."
      );
    default:
      return (
        "✅ Payment received successfully.\n\n" +
        "A contractor is being assigned.\n" +
        "You will be notified via WhatsApp."
      );
  }
}

/* ================= HANDLER ================= */
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
    const raw = await readRawBody(req);

    event = stripe.webhooks.constructEvent(
      raw,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Stripe signature failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ ignored: true });
  }

  const checkoutSession = event.data.object as Stripe.Checkout.Session;

  if (checkoutSession.payment_status !== "paid") {
    return res.status(200).json({ ignored: true });
  }

  const paymentId = checkoutSession.payment_intent as string;
  const ticketId = checkoutSession.metadata?.ticket_id;

  const amount =
  (checkoutSession.amount_total ?? 0) / 100;

  if (!paymentId || !ticketId) {
    return res.status(200).json({ ignored: true });
  }

  try {
    /* ===== IDEMPOTENCY ===== */
    const { data: exists } = await supabase
      .from("payments")
      .select("id")
      .eq("gateway_payment_id", paymentId)
      .maybeSingle();

    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    /* ===== LOAD TICKET ===== */
    const { data: ticket } = await supabase
      .from("tickets")
      .select("id, condo_id")
      .eq("id", ticketId)
      .maybeSingle();

    if (!ticket) {
      throw new Error("Ticket not found");
    }

     /* ===== LOAD SESSION ===== */
    const { data: convSession } = await supabase
  .from("conversation_sessions")
  .select("phone_number, language")
  .eq("condo_id", ticket.condo_id)
  .eq("current_ticket_id", ticket.id)
  .maybeSingle();

if (!convSession) {
  throw new Error("Conversation session not found");
}

    /* ===== SAVE PAYMENT ===== */
    await supabase.from("payments").insert({
      ticket_id: ticket.id,
      gateway_payment_id: paymentId,
      amount,
      currency: "MYR",
      status: "paid",
      provider: "stripe",
      payment_type: "diagnosis"
    });

    /* ===== UPDATE TICKET ===== */
    await supabase
      .from("tickets")
      .update({ status: "paid" })
      .eq("id", ticket.id);

    /* ===== UPDATE CONVERSATION STATE (POST PAYMENT) ===== */
await supabase
  .from("conversation_sessions")
  .update({
    state: "post_payment",
    current_ticket_id: null,
    updated_at: new Date()
  })
  .eq("condo_id", ticket.condo_id)
  .eq("phone_number", convSession.phone_number);


    /* ===== SEND WHATSAPP (LANG LOCKED) ===== */
    try {
      await sendWhatsApp(
        convSession.phone_number,
        paymentSuccessText(convSession.language || "en")
      );
    } catch (waErr) {
      console.error("⚠️ WhatsApp failed:", waErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("🔥 Webhook error:", err);
    return res.status(200).json({ handled: false });
  }
}
