import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import coreHandler from "./ticket-intake";

/* ================= ⭐CLIENT ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ================= ⭐SEND WHATSAPP ================= */
async function sendWhatsAppMessage(phone: string, text: string) {
  await fetch(process.env.WHATSAPP_SEND_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: phone,
      message: text
    })
  });
}

export default async function worker(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  /* 1️⃣ Get ONE pending job */
  const { data: job } = await supabase
    .from("job_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!job) {
    return res.status(200).json({ ok: true, empty: true });
  }

  /* 2️⃣ Mark processing */
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  let replyText: string | null = null;

  const fakeRes = {
    status: () => ({
      json: (data: any) => {
        if (data?.reply_text) replyText = data.reply_text;
        return null;
      }
    })
  } as any;

  try {
    /* 3️⃣ Run business logic */
    await coreHandler({} as any, fakeRes, job.payload);

    /* 4️⃣ Send WhatsApp reply */
    if (replyText) {
      await sendWhatsAppMessage(job.phone_number, replyText);
    }

    /* 5️⃣ Done */
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (err: any) {
    await supabase
      .from("job_queue")
      .update({
        status: "failed",
        error_message: err?.message ?? "unknown"
      })
      .eq("id", job.id);
  }

  return res.status(200).json({ ok: true });
}
