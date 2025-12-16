import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const supabaseUrl = process.env.SUPABASE_URL || "MISSING";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "MISSING";

  const supabase = createClient(supabaseUrl, serviceKey);

  const payload = {
    condo_id: "b7f6c1a8-1b23-4a5e-9d7a-12e34abc5678",
    description_raw: "FINAL DEBUG INSERT",
    description_clean: "FINAL DEBUG INSERT",
    source: "final-debug",
    status: "new",
    is_common_area: false,
  };

  const result = await supabase
    .from("tickets")
    .insert(payload)
    .select()
    .single();

  return res.status(200).json({
    supabaseUrlUsed: supabaseUrl,
    insertError: result.error,
    insertedRow: result.data,
  });
}
