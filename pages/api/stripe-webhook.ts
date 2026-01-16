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
        "🔧 Tiket penyelenggaraan anda sedang diproses dan kontraktor sedang ditugaskan.\n" +
        "Kami akan memaklumkan anda melalui WhatsApp sebelum lawatan dibuat.\n\n" +
        "➕ Perlu laporkan masalah lain?\n" +
        "Balas *NEW* untuk hantar tiket baharu."
      );

    case "zh":
      return (
        "✅ 付款已成功完成。\n\n" +
        "🔧 您的维修工单正在处理中，承包商正在分配中。\n" +
        "在上门前，我们会通过 WhatsApp 通知您。\n\n" +
        "➕ 需要提交新的维修问题？\n" +
        "请回复 *NEW* 创建新的工单。"
      );

    case "ta":
      return (
        "✅ கட்டணம் வெற்றிகரமாக பெறப்பட்டது.\n\n" +
        "🔧 உங்கள் பராமரிப்பு டிக்கெட் செயல்பாட்டில் உள்ளது, ஒப்பந்ததாரர் நியமிக்கப்படுகிறார்.\n" +
        "வருகைக்கு முன் WhatsApp மூலம் உங்களுக்கு அறிவிக்கப்படும்.\n\n" +
        "➕ மற்றொரு பிரச்சனையை பதிவு செய்ய வேண்டுமா?\n" +
        "*NEW* என்று பதிலளிக்கவும்."
      );

    default:
      return (
        "✅ Payment received successfully.\n\n" +
        "🔧 Your maintenance ticket is being processed and a contractor is being assigned.\n" +
        "You’ll be notified via WhatsApp before the visit.\n\n" +
        "➕ Need to report another issue?\n" +
        "Reply *NEW* to create a new ticket."
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
