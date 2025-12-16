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
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const rawText =
      typeof req.body === "string"
        ? req.body
        : req.body?.Body || req.body?.text || null;

    const { error } = await supabase
      .from("ticket_raw_logs")
      .insert({
        source: "make",
        raw_headers: req.headers,
        raw_body: req.body,
        raw_text: rawText,
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "Raw data logged",
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}

