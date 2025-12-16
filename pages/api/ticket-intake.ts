import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =====================================================
   Supabase client (SERVICE ROLE)
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* =====================================================
   OpenAI client (optional, never blocks)
===================================================== */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   API handler
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  /* -----------------------------------------------
     ROUTE GUARD
  ------------------------------------------------ */
  if (req.method !== "POST") {
    console.log("ℹ️ Non-POST request received");
    return res.status(200).json({
      ok: true,
      message: "Ticket intake reached",
      method: req.method,
    });
  }

  try {
    console.log("🚀 === TICKET INTAKE START ===");

    console.log("📦 Raw body:", req.body);
    console.log("🔑 ENV CHECK:", {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    });

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const { condo_id, description_raw } = body;

    if (!condo_id || !description_raw) {
      console.log("❌ Missing required fields", body);
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ INSERT TICKET (ALWAYS)
    -------------------------------------------------- */
    console.log("📝 Inserting ticket into Supabase...");

    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area: false,
        is_duplicate: false,
      })
      .select()
      .single();

    if (insertError || !ticket) {
      console.error("❌ Ticket insert failed", insertError);
      return res.status(500).json({
        error: insertError?.message || "Ticket insert failed",
      });
    }

    console.log("✅ Ticket inserted:", ticket.id);

    /* -------------------------------------------------
       2️⃣ EMBEDDING (BEST EFFORT, NEVER BLOCKS)
    -------------------------------------------------- */
    if (!openai) {
      console.log("⚠️ OpenAI disabled — embedding skipped");
    } else {
      try {
        console.log("🧠 Creating embedding...");

        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: description_raw,
        });

        const embedding = embeddingResponse.data?.[0]?.embedding;

        if (!embedding) {
          console.log("⚠️ No embedding returned from OpenAI");
        } else {
          console.log("📐 Embedding length:", embedding.length);

          await supabase
            .from("tickets")
            .update({
              embedding: embedding as unknown as number[],
            })
            .eq("id", ticket.id);

          console.log("💾 Embedding saved");
        }
      } catch (err) {
        console.error("⚠️ Embedding failed (non-blocking):", err);
      }
    }

    console.log("🏁 === TICKET INTAKE COMPLETE ===");

    /* -------------------------------------------------
       3️⃣ RESPONSE
    -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
    });
  } catch (err: any) {
    console.error("🔥 UNCAUGHT ERROR", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
