import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { coreHandler } from "./ticket-intake";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function worker(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  // 1️⃣ Fetch ONE pending job
  const { data: job } = await supabase
    .from("job_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(3)
    .maybeSingle();

  // Nothing to process
  if (!job) {
    return res.status(200).json({ ok: true, empty: true });
  }

  // 2️⃣ Mark as processing
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  try {
    // 3️⃣ Execute FULL business logic
    await coreHandler(
      {} as any,
      { status: () => ({ json: () => null }) } as any,
      job.payload
    );

    // 4️⃣ Mark job done
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (err) {
    // 5️⃣ Mark failed (never block queue)
    await supabase
      .from("job_queue")
      .update({ status: "failed" })
      .eq("id", job.id);
  }

  return res.status(200).json({ ok: true });
}
