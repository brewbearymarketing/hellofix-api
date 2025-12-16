import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      condo_id,
      description_raw,
    } = req.body;

    // Basic validation
    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    // Insert into tickets table
    const { data, error } = await supabase
      .from("tickets")
      .insert({
        condo_id: condo_id,
        description_raw: description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area: false,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      ticket_id: data.id,
    });

  } catch (err: any) {
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
