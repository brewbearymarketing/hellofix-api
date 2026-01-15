import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16"
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const ticket_id = req.query.ticket_id as string;

  if (!ticket_id) {
    return res.status(400).send("Missing ticket_id");
  }

  // Load ticket (safety)
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, diagnosis_fee, status")
    .eq("id", ticket_id)
    .maybeSingle();

  if (!ticket || ticket.status !== "confirmed") {
    return res.status(400).send("Invalid ticket");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "link"],
    line_items: [
      {
        price_data: {
          currency: "myr",
          unit_amount: ticket.diagnosis_fee * 100,
          product_data: {
            name: "Diagnosis Fee"
          }
        },
        quantity: 1
      }
    ],
    success_url: "https://hellofix-api.vercel.app/payment/success",
    cancel_url: "https://hellofix-api.vercel.app/payment/cancelled",

    metadata: {
      ticket_id
    }
  });

  return res.redirect(303, session.url!);
}
