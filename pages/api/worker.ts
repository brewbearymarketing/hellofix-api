import { createClient } from "@supabase/supabase-js";
import type { NextApiRequest, NextApiResponse } from "next";
import { coreHandler } from "./ticket-intake"; // reuse your logic

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function worker(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 1️⃣ Fetch ONE pending job
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

  // 2️⃣ Mark as processing
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  try {
    // 3️⃣ RUN YOUR EXISTING LOGIC
    await coreHandler(
      {} as any,
      { status: () => ({ json: () => null }) } as any,
      job.payload
    );

    // 4️⃣ Mark done
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (e) {
    await supabase
      .from("job_queue")
      .update({ status: "failed" })
      .eq("id", job.id);
  }

  return res.status(200).json({ ok: true });
}
import { createClient } from "@supabase/supabase-js";
import type { NextApiRequest, NextApiResponse } from "next";
import { coreHandler } from "./ticket-intake"; // reuse your logic

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function worker(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 1️⃣ Fetch ONE pending job
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

  // 2️⃣ Mark as processing
  await supabase
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", job.id);

  try {
    // 3️⃣ RUN YOUR EXISTING LOGIC
    await coreHandler(
      {} as any,
      { status: () => ({ json: () => null }) } as any,
      job.payload
    );

    // 4️⃣ Mark done
    await supabase
      .from("job_queue")
      .update({ status: "done" })
      .eq("id", job.id);

  } catch (e) {
    await supabase
      .from("job_queue")
      .update({ status: "failed" })
      .eq("id", job.id);
  }

  return res.status(200).json({ ok: true });
}
