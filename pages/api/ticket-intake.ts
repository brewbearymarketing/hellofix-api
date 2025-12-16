import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

/* =====================================================
   ENV CHECK (FAIL FAST, CLEAR ERROR)
===================================================== */
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  MAKE_WEBHOOK_SECRET,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MAKE_WEBHOOK_SECRET) {
  throw new Error("Missing required environment variables");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* =====================================================
   API HANDLER (BASELINE)
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    /* ---------- METHOD ---------- */
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    /* ---------- AUTH ---------- */
    const secret = req.headers["x-make-secret"];
    if (secret !== MAKE_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /* ---------- BODY VALIDATION ---------- */
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing required fields: condo_id, description_raw",
      });
    }

    /* ---------- CLEAN TEXT ---------- */
    const description_clean = String(description_raw)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    /* ---------- INSERT ONLY ---------- */
    const { data, error } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        description_clean,
        source: "whatsapp",
        status: "new",
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({
        error: "Database insert failed",
        detail: error.message,
      });
    }

    /* ---------- SUCCESS ---------- */
    return res.status(200).json({
      ticket_id: data.id,
      message: "Ticket created successfully",
    });

  } catch (err: any) {
    console.error("Ticket intake fatal error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err?.message ?? "Unknown error",
    });
  }
}
