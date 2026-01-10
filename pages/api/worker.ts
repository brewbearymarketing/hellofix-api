import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: coreHandler is default export in v11
import coreHandler from "./ticket-intake";

import { withPhoneLock } from "@/lib/withPhoneLock";

/* ================= ⭐CLIENT ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* =====================================================
   🧵 BACKGROUND WORKER
   - Triggered by Vercel Cron
   - Processes ONE job at a time
   - Serialised per phone_number
   - CAPTURES reply_text for WhatsApp
===================================================== */
export default async function worker(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  /* ================= 1️⃣ FETCH ONE PENDING JOB ================= */
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

  /* ================= 2️⃣ MARK AS PROCESSING ================= */
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  let replyPayload: any = null;

  /* ================= 3️⃣ FAKE RESPONSE (CAPTURE JSON) ================= */
  const fakeRes = {
    status: () => ({
      json: (payload: any) => {
        replyPayload = payload;
        return payload;
      }
    })
  } as any;

  try {
    /* ================= 4️⃣ PHONE-LEVEL SERIALISATION ================= */
    await withPhoneLock(
      supabase,
      job.phone_number,
      async () => {
        await coreHandler(
          {} as any, // req unused
          fakeRes,
          job.payload
        );
      }
    );

    /* ================= 5️⃣ SAVE WHATSAPP REPLY ================= */
    if (replyPayload?.reply_text) {
      await supabase.from("outgoing_messages").insert({
        condo_id: job.condo_id,
        phone_number: job.phone_number,
        reply_text: replyPayload.reply_text
      });
    }

    /* ================= 6️⃣ MARK DONE ================= */
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (err: any) {
    console.error("🔥 WORKER ERROR:", err);

    /* ================= 7️⃣ MARK FAILED ================= */
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
