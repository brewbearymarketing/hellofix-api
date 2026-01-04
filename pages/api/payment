import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { buffer } from "micro";

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16"
});

/* ================= DISABLE BODY PARSER ================= */
export const config = {
  api: {
    bodyParser: false
  }
};

/* ================= WHATSAPP SENDER (PLACEHOLDER) ================= */
async function sendWhatsAppMessage(phone: string, message: string) {
  console.log("📤 WhatsApp →", phone);
  console.log(message);
}

/* ================= API HANDLER ================= */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  let event: Stripe.Event;

  try {
    const sig = req.headers["stripe-signature"] as string;
    const buf = await buffer(req);

    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Stripe signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  /* ================= ONLY HANDLE SUCCESS EVENTS ================= */
  let gateway_payment_id: string | null = null;
  let ticket_id: string | null = null;
  let amount = 0;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    gateway_payment_id = session.payment_intent as string;
    ticket_id = session.metadata?.ticket_id ?? null;
    amount = (session.amount_total ?? 0) / 100;
  } else if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;

    gateway_payment_id = pi.id;
    ticket_id = pi.metadata?.ticket_id ?? null;
    amount = (pi.amount_received ?? 0) / 100;
  } else {
    return res.status(200).json({ ignored: true });
  }

  if (!gateway_payment_id || !ticket_id) {
    console.error("❌ Missing ticket_id or payment id");
    return res.status(400).json({ error: "Missing metadata" });
  }

  try {
    /* ================= LOAD TICKET ================= */
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("id, condo_id, phone_number, language, status")
      .eq("id", ticket_id)
      .maybeSingle();

    if (ticketError || !ticket) {
      throw new Error("Ticket not found");
    }

    /* ================= IDEMPOTENCY GUARD ================= */
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id")
      .eq("gateway_payment_id", gateway_payment_id)
      .eq("status", "paid")
      .maybeSingle();

    if (existingPayment) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    /* ================= INSERT PAYMENT ================= */
    await supabase.from("payments").insert({
      ticket_id: ticket.id,
      gateway_payment_id,
      amount,
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

    /* ================= ASSIGN CONTRACTOR (SIMPLE) ================= */
    const { data: contractor } = await supabase
      .from("contractors")
      .select("id")
      .eq("condo_id", ticket.condo_id)
      .eq("active", true)
      .order("rating", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contractor) {
      await supabase
        .from("tickets")
        .update({ contractor_id: contractor.id })
        .eq("id", ticket.id);
    }

    /* ================= WHATSAPP CONFIRMATION ================= */
    const lang = ticket.language ?? "en";
    let message = "";

    switch (lang) {
      case "ms":
        message =
          "✅ Pembayaran telah disahkan.\n" +
          "Kontraktor akan ditugaskan dan akan menghubungi anda.\n\n" +
          "Terima kasih.";
        break;

      case "zh":
        message =
          "✅ 付款已确认。\n" +
          "已分配承包商，稍后将与您联系。\n\n" +
          "谢谢。";
        break;

      case "ta":
        message =
          "✅ கட்டணம் உறுதிப்படுத்தப்பட்டது.\n" +
          "ஒப்பந்ததாரர் நியமிக்கப்பட்டு உங்களை தொடர்புகொள்வார்.\n\n" +
          "நன்றி.";
        break;

      default:
        message =
          "✅ Payment confirmed.\n" +
          "A contractor is being assigned and will contact you.\n\n" +
          "Thank you.";
    }

    await sendWhatsAppMessage(ticket.phone_number, message);

    /* ================= RESET CONVERSATION ================= */
    await supabase
      .from("conversation_sessions")
      .update({
        state: "intake",
        current_ticket_id: null,
        updated_at: new Date()
      })
      .eq("condo_id", ticket.condo_id)
      .eq("phone_number", ticket.phone_number);

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("🔥 STRIPE WEBHOOK ERROR:", err);
    return res.status(500).json({
      error: "Webhook handler failed",
      detail: err.message
    });
  }
}
