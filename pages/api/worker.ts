import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: coreHandler is NOT a named export in v11
// So we import default
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
===================================================== */
export default async function worker(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  /* ================= 1️⃣ FETCH ONE PENDING JOB ================= */
  const { data: job, error } = await supabase
    .from("job_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !job) {
    // Nothing to do
    return res.status(200).json({ ok: true, empty: true });
  }

  /* ================= 2️⃣ MARK AS PROCESSING ================= */
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  /* ================= 3️⃣ FAKE RESPONSE (worker-safe) ================= */
  const fakeRes = {
    status: () => ({
      json: () => null
    })
  } as any;

  try {
    /* ================= 4️⃣ PHONE-LEVEL SERIALISATION ================= */
    await withPhoneLock(
      supabase,
      job.phone_number,
      async () => {
        await coreHandler(
          {} as any,   // req is not used inside coreHandler
          fakeRes,
          job.payload
        );
      }
    );

    /* ================= 5️⃣ MARK DONE ================= */
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (err: any) {
    console.error("🔥 WORKER ERROR:", err);

    /* ================= 6️⃣ MARK FAILED ================= */
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
