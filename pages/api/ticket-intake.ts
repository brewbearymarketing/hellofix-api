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
   OpenAI client
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
    console.log("🚀 TICKET INTAKE START");

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const {
      condo_id,
      description_raw,
      unit_id = null,
      is_common_area = false,
    } = body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ INSERT TICKET
    -------------------------------------------------- */
    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area,
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
       2️⃣ CREATE EMBEDDING
    -------------------------------------------------- */
    let embedding: number[] | null = null;

    if (openai) {
      try {
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: description_raw,
        });

        embedding = embeddingResponse.data?.[0]?.embedding ?? null;

        if (embedding) {
          await supabase
            .from("tickets")
            .update({ embedding })
            .eq("id", ticket.id);
        }
      } catch (e) {
        console.error("⚠️ Embedding failed", e);
      }
    }

    /* -------------------------------------------------
       3️⃣ DUPLICATE / RELATED LOGIC (HYBRID)
    -------------------------------------------------- */
    let duplicateOf: string | null = null;
    let relatedTo: string | null = null;

    if (embedding) {
      const { data: matches } = await supabase.rpc(
        "match_tickets",
        {
          query_embedding: embedding,
          condo_filter: condo_id,
          exclude_id: ticket.id,
          created_before: ticket.created_at,
          match_threshold: 0.85,
          match_count: 1,
        }
      );

      if (matches && matches.length > 0) {
        const best = matches[0];

        // 🔴 COMMON AREA → HARD DUPLICATE
        if (ticket.is_common_area || best.is_common_area) {
          duplicateOf = best.id;
        }
        // 🔴 SAME UNIT → HARD DUPLICATE
        else if (
          ticket.unit_id &&
          best.unit_id &&
          ticket.unit_id === best.unit_id
        ) {
          duplicateOf = best.id;
        }
        // 🟡 DIFFERENT UNIT → RELATED
        else {
          relatedTo = best.id;
        }

        await supabase
          .from("tickets")
          .update({
            is_duplicate: !!duplicateOf,
            duplicate_of: duplicateOf,
            related_to: relatedTo,
          })
          .eq("id", ticket.id);
      }
    }

    /* -------------------------------------------------
       4️⃣ RESPONSE
    -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      is_duplicate: !!duplicateOf,
      duplicate_of: duplicateOf,
      related_to: relatedTo,
    });
  } catch (err: any) {
    console.error("🔥 Uncaught error", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
