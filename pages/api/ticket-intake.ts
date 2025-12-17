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
       1️⃣ INSERT TICKET (ALWAYS FIRST)
    -------------------------------------------------- */
    console.log("📝 Inserting ticket...");

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
       2️⃣ CREATE EMBEDDING (BEST EFFORT)
    -------------------------------------------------- */
    let embedding: number[] | null = null;

    if (!openai) {
      console.log("⚠️ OpenAI disabled (no API key)");
    } else {
      try {
        console.log("🧠 Creating embedding...");

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
        console.error("⚠️ Embedding failed (ignored):", err);
      }
    }

  /* -------------------------------------------------
   3️⃣ DUPLICATE DETECTION
-------------------------------------------------- */
let duplicateOf: string | null = null;

if (embedding) {
  console.log("🔍 Running duplicate search…");

  const { data: matches, error: matchError } =
    await supabase.rpc("match_tickets", {
      query_embedding: embedding,
      condo_filter: condo_id,
      exclude_id: ticket.id,
      created_before: ticket.created_at,
      match_threshold: 0.85,
      match_count: 1,
    });

  console.log("🧪 match_tickets result:", matches);

  if (matchError) {
    console.error("❌ match_tickets error:", matchError);
  } else if (matches && matches.length > 0) {
    const bestMatch = matches[0];

    if (typeof bestMatch.similarity === "number") {
      console.log(
        "🧠 Similarity score:",
        bestMatch.similarity
      );

      duplicateOf = bestMatch.id;

      await supabase
        .from("tickets")
        .update({
          is_duplicate: true,
          duplicate_of: duplicateOf,
        })
        .eq("id", ticket.id);

      console.log("🔁 DUPLICATE CONFIRMED:", duplicateOf);
    } else {
      console.warn("⚠️ similarity missing from RPC result");
    }
  } else {
    console.log("✅ No duplicate found");
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
    });
  } catch (err: any) {
    console.error("🔥 Uncaught error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
