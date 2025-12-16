import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: "Missing Supabase env vars",
      supabaseUrlExists: !!supabaseUrl,
      serviceKeyExists: !!serviceKey,
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const testPayload = {
      condo_id: "b7f6c1a8-1b23-4a5e-9d7a-12e34abc5678",
      description_raw: "FORCED DEBUG INSERT",
      description_clean: "FORCED DEBUG INSERT",
      source: "debug",
      status: "new",
      is_common_area: false,
    };

    const result = await supabase
      .from("tickets")
      .insert(testPayload)
      .select()
      .single();

    if (result.error) {
      throw result.error;
    }

    return res.status(200).json({
      success: true,
      inserted_row: result.data,
    });

  } catch (err: any) {
    return res.status(500).json({
      error: "SUPABASE INSERT FAILED",
      message: err.message,
      details: err,
    });
  }
}
