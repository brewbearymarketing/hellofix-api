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
   OpenAI client (optional)
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
    return res.status(200).json({
      ok: true,
      message: "Ticket intake reached",
      method: req.method,
    });
  }

  try {
    console.log("🚀 Ticket intake start");

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const { condo_id, description_raw } = body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ Insert ticket
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

    console.log("✅ Ticket inserted:", ticket.id);

    /* -------------------------------------------------
       2️⃣ Create embedding (BEST EFFORT)
    -------------------------------------------------- */
    let embedding: number[] | null = null;

    if (!openai) {
      console.log("⚠️ OpenAI disabled");
    } else {
      try {
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: description_raw,
        });

        embedding = embeddingResponse.data?.[0]?.embedding ?? null;

        if (embedding) {
          console.log("📐 Embedding created:", embedding.length);

          await supabase
            .from("tickets")
            .update({
              embedding: embedding as unknown as number[],
            })
            .eq("id", ticket.id);
        }
      } catch (err) {
        console.error("⚠️ Embedding failed:", err);
      }
    }

    /* -------------------------------------------------
       3️⃣ Duplicate detection (ONLY if embedding exists)
    -------------------------------------------------- */
    let duplicateOf: string | null = null;

    if (embedding) {
      const { data: matches, error: matchError } =
        await supabase.rpc("match_tickets", {
          query_embedding: embedding,
          match_threshold: 0.9,
          match_count: 1,
          condo_filter: condo_id,
          exclude_id: ticket.id,
        });

      if (matchError) {
        console.error("❌ match_tickets error:", matchError);
      } else if (matches && matches.length > 0) {
        duplicateOf = matches[0].id;

        await supabase
          .from("tickets")
          .update({
            is_duplicate: true,
            duplicate_of: duplicateOf,
          })
          .eq("id", ticket.id);

        console.log("🔁 Duplicate detected:", duplicateOf);
      }
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
    console.error("🔥 Uncaught error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
