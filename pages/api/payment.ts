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

/* ================= API HANDLER ================= */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
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
    console.error("❌ Stripe signature verification failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  /* ================= HANDLE SUCCESS EVENTS ================= */
let gateway_payment_id: string;
let ticket_id: string;
let amount: number;

if (event.type !== "checkout.session.completed") {
  return res.status(200).json({ ignored: true });
}

const session = event.data.object as Stripe.Checkout.Session;

// ✅ Stripe guarantee: checkout completed + paid
if (session.payment_status !== "paid") {
  return res.status(200).json({ ignored: true });
}

gateway_payment_id = session.payment_intent as string;
ticket_id = session.metadata?.ticket_id!;
amount = (session.amount_total ?? 0) / 100;

if (!ticket_id || !gateway_payment_id) {
  console.error("❌ Missing ticket_id or payment_intent");
  return res.status(200).json({ ignored: true });
}

    /* ================= IDEMPOTENCY CHECK ================= */
   try {
     const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("gateway_payment_id", gateway_payment_id)
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    /* ================= LOAD TICKET ================= */
    const { data: ticket } = await supabase
      .from("tickets")
      .select("id, condo_id, phone_number, language")
      .eq("id", ticket_id)
      .maybeSingle();

    if (!ticket) {
      throw new Error("Ticket not found");
    }

    /* ================= INSERT PAYMENT ================= */
    await supabase.from("payments").insert({
      ticket_id: ticket.id,
      gateway_payment_id: gateway_payment_id,
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


    /* ================= RESET CONVERSATION ================= */
 await supabase
  .from("conversation_sessions")
  .update({
    state: "contractor_assignment",
    updated_at: new Date()
  })
  .eq("condo_id", ticket.condo_id)
  .eq("phone_number", ticket.phone_number);

    return res.status(200).json({ ok: true });
  } 

    catch (err: any) {
    console.error("🔥 PAYMENT WEBHOOK ERROR:", err);
    return res.status(500).json({
      error: "Payment processing failed",
      detail: err.message
    });
  }

       /* ================= SEND WHATSAPP ================= */
  await sendWhatsApp(
  ticket.phone_number,
  ticket.language === "ms"
    ? "✅ Pembayaran berjaya diterima.\n\nKontraktor sedang ditugaskan. Anda akan dimaklumkan sebelum lawatan."
    : ticket.language === "zh"
    ? "✅ 付款成功。\n\n正在分配承包商，稍后将与您联系。"
    : ticket.language === "ta"
    ? "✅ கட்டணம் வெற்றிகரமாக பெறப்பட்டது.\n\nஒப்பந்ததாரர் நியமிக்கப்படுகிறார்."
    : "✅ Payment received.\n\nA contractor is being assigned. You will be contacted shortly."
);
}
