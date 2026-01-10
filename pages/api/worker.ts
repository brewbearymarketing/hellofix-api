import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req, res) {
  const { data: job } = await supabase
    .from("job_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!job) {
    return res.status(200).json({ ok: true, message: "No jobs" });
  }

  // 🔒 lock job
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  try {
    // ⬇⬇⬇ THIS IS WHERE coreHandler IS USED ⬇⬇⬇
    await coreHandler(
      {} as any,
      {} as any,
      job.payload
    );

    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);
  } catch (err: any) {
    await supabase
      .from("job_queue")
      .update({
        status: "failed",
        error: err.message
      })
      .eq("id", job.id);
  }

  return res.status(200).json({ success: true });
}
