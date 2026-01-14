import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { coreHandler } from "./ticket-intake";

/* ================= CLIENT ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ================= PHONE LOCK ================= */
async function withPhoneLock(
  supabase: any,
  phone_number: string,
  fn: () => Promise<void>
) {
  const lockKey = `phone:${phone_number}`;

  const { data } = await supabase.rpc("acquire_phone_lock", {
    lock_key: lockKey
  });

 if (!data) {
  throw new Error("PHONE_LOCKED_RETRY");
}


  try {
    await fn();
  } finally {
    await supabase.rpc("release_phone_lock", {
      lock_key: lockKey
    });
  }
}

/* ================= SEND WHATSAPP ================= */
async function sendWhatsAppMessage(
  phone_number: string,
  message: string
) {
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

/* ================= WORKER ================= */
export default async function worker(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({ error: "Missing phone_number" });
  }

    /* 1️⃣ FETCH ONE JOB */
  const { data: job } = await supabase
  .from("job_queue")
  .select("*")
  .eq("phone_number", phone_number)
  .eq("status", "pending")
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();

if (!job) {
  return res.status(200).json({ ok: true });
}

  /* 2️⃣ MARK PROCESSING */
await supabase
  .from("job_queue")
  .update({ status: "processing" })
  .eq("id", job.id);

  let replyText: string | null = null;

  /* 3️⃣ FAKE RESPONSE (CAPTURE reply_text) */
  const fakeRes = {
    status: () => ({
      json: (data: any) => {
        if (data?.reply_text) {
          replyText = data.reply_text;
        }
        return null;
      }
    })
  } as any;

  try {
    /* 4️⃣ RUN CORE HANDLER (SERIALISED PER PHONE) */
    await withPhoneLock(
      supabase,
      job.phone_number,
      async () => {
        await coreHandler(
          {} as any,
          fakeRes,
          job.payload
        );
      }
    );

    /* 5️⃣ SEND WHATSAPP */
    if (replyText) {
      await sendWhatsAppMessage(job.phone_number, replyText);
    }

    /* 6️⃣ DONE */
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (err: any) {
    console.error("WORKER ERROR:", err);

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
