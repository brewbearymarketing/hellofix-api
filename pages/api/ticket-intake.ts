import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =====================================================
   Supabase client
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* =====================================================
   OpenAI client (v6)
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ Insert ticket FIRST (never blocked by AI)
    -------------------------------------------------- */
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
      return res.status(500).json({
        error: insertError?.message || "Ticket insert failed",
      });
    }

      /* =====================================================
      🔍 DEBUG: CHECK OPENAI KEY AVAILABILITY
      THIS IS THE KEY LINE YOU ASKED FOR
      ===================================================== */
    console.log(
      "OPENAI_API_KEY exists:",
      !!process.env.OPENAI_API_KEY
    );

    /* -------------------------------------------------
       2️⃣ Duplicate detection (BEST-EFFORT)
    -------------------------------------------------- */
    let duplicateOf: string | null = null;

    if (openai) {
      try {
        /* Create embedding */
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: description_raw,
        });

        const embedding = embeddingResponse.data[0].embedding;

        /* Store embedding (cast to avoid TS/vector issues) */
        await supabase
          .from("tickets")
          .update({
            embedding: embedding as unknown as number[],
          })
          .eq("id", ticket.id);

        /* Find similar open tickets */
        const { data: matches } = await supabase.rpc(
          "match_tickets",
          {
            query_embedding: embedding,
            match_threshold: 0.85,
            match_count: 1,
            condo_filter: condo_id,
            exclude_id: ticket.id,
          }
        );

        if (matches && matches.length > 0) {
          duplicateOf = matches[0].id;
        }
      } catch (aiErr) {
        // IMPORTANT: never fail ticket creation
        console.error("Duplicate check skipped:", aiErr);
      }
    }

    /* -------------------------------------------------
       3️⃣ Mark duplicate if found
    -------------------------------------------------- */
    if (duplicateOf) {
      await supabase
        .from("tickets")
        .update({
          is_duplicate: true,
          duplicate_of: duplicateOf,
        })
        .eq("id", ticket.id);
    }

    /* -------------------------------------------------
       4️⃣ Response
    -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      is_duplicate: !!duplicateOf,
      duplicate_of: duplicateOf,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
