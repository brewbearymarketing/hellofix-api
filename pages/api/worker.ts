import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: coreHandler is default export
import coreHandler from "./ticket-intake";

/* ================= ⭐CLIENT ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ================= 🔒 PHONE LOCK ================= */
async function withPhoneLock(
  supabase: any,
  phone_number: string,
  fn: () => Promise<void>
) {
  const lockKey = `phone:${phone_number}`;

  const { data } = await supabase.rpc("acquire_phone_lock", {
    lock_key: lockKey
  });

  if (!data) return null;

  try {
    return await fn();
  } finally {
    await supabase.rpc("release_phone_lock", {
      lock_key: lockKey
    });
  }
}

/* ================= 📤 SEND WHATSAPP ================= */
async function sendWhatsAppMessage(
  phone_number: string,
  message: string
) {
  // 👉 Call your EXISTING Make / Twilio webhook
  await fetch(process.env.MAKE_SEND_WHATSAPP_WEBHOOK!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone_number,
      message
    })
  });
}

/* =====================================================
   🧵 BACKGROUND WORKER
===================================================== */
export default async function worker(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  /* 1️⃣ FETCH JOB */
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

  /* 2️⃣ MARK PROCESSING */
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  let replyText: string | null = null;

  /* 3️⃣ FAKE RESPONSE */
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
    /* 4️⃣ RUN CORE LOGIC (SERIALISED) */
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
    console.error("🔥 WORKER ERROR:", err);

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


