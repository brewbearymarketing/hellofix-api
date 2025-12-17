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
   OpenAI client (never blocks ticket creation)
===================================================== */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   UNIT EXTRACTION — RULE BASED (PRODUCTION SAFE)
===================================================== */
async function resolveUnitFromText(
  condo_id: string,
  text: string
): Promise<{ unit_id: string | null; unit_label: string | null }> {
  console.log("🔎 UNIT EXTRACTION START");
  console.log("🧪 RAW TEXT:", text);

  // Matches: A-12-3 | A 12 3 | Block A-12-3
  const match = text.match(
    /(block\s*)?([A-Z])\s*[-\s]?\s*(\d{1,2})\s*[-\s]?\s*(\d{1,2})/i
  );

  console.log("🧪 REGEX MATCH:", match);

  if (!match) return { unit_id: null, unit_label: null };

  const block = match[2].toUpperCase();
  const x = parseInt(match[3], 10);
  const y = parseInt(match[4], 10);

  console.log("🧪 PARSED NUMBERS:", { x, y });

  // Load condo rules
  const { data: rules, error } = await supabase
    .from("condo_unit_rules")
    .select("*")
    .eq("condo_id", condo_id)
    .single();

  if (error || !rules) {
    console.warn("⚠️ Condo rules missing");
    return { unit_id: null, unit_label: null };
  }

  const {
    min_floor,
    max_floor,
    min_unit,
    max_unit,
    format,
  } = rules;

  const xIsFloor = x >= min_floor && x <= max_floor;
  const yIsUnit = y >= min_unit && y <= max_unit;
  const yIsFloor = y >= min_floor && y <= max_floor;
  const xIsUnit = x >= min_unit && x <= max_unit;

  let unit_label: string | null = null;

  if (format === "BLOCK-FLOOR-UNIT" && xIsFloor && yIsUnit) {
    unit_label = `${block}-${x}-${y}`;
  } else if (format === "BLOCK-UNIT-FLOOR" && xIsUnit && yIsFloor) {
    unit_label = `${block}-${y}-${x}`;
  } else {
    console.warn("⚠️ UNIT AMBIGUOUS — NOT AUTO ASSIGNED");
    return { unit_id: null, unit_label: null };
  }

  console.log("🏷️ NORMALIZED UNIT:", unit_label);

  // Resolve or create unit
  const { data: existing } = await supabase
    .from("units")
    .select("id")
    .eq("condo_id", condo_id)
    .eq("unit_label", unit_label)
    .single();

  if (existing) {
    console.log("✅ UNIT FOUND:", existing.id);
    return { unit_id: existing.id, unit_label };
  }

  const { data: created } = await supabase
    .from("units")
    .insert({ condo_id, unit_label })
    .select()
    .single();

  console.log("🆕 UNIT CREATED:", created?.id);

  return {
    unit_id: created?.id ?? null,
    unit_label,
  };
}

/* =====================================================
   API HANDLER
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Ticket intake reached",
    });
  }

  try {
    console.log("🚀 === TICKET INTAKE START ===");

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const {
      condo_id,
      description_raw,
      is_common_area = false,
    } = body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ RESOLVE UNIT FIRST (CRITICAL FIX)
    -------------------------------------------------- */
    let unit_id: string | null = null;
    let unit_label: string | null = null;

    if (!is_common_area) {
      const resolved = await resolveUnitFromText(
        condo_id,
        description_raw
      );
      unit_id = resolved.unit_id;
      unit_label = resolved.unit_label;
    }

    console.log("🧪 UNIT BEFORE INSERT:", { unit_id, unit_label });

    /* -------------------------------------------------
       2️⃣ INSERT TICKET (WITH unit_id)
    -------------------------------------------------- */
    console.log("📝 Inserting ticket...");

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
       3️⃣ CREATE EMBEDDING
    -------------------------------------------------- */
    let embedding: number[] | null = null;

    if (openai) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_raw,
      });

      embedding = emb.data[0].embedding;

      await supabase
        .from("tickets")
        .update({ embedding })
        .eq("id", ticket.id);

      console.log("📐 Embedding created:", embedding.length);
    }

    /* -------------------------------------------------
       4️⃣ DUPLICATE / RELATED LOGIC
    -------------------------------------------------- */
    let duplicateOf: string | null = null;
    let relatedTo: string | null = null;

    if (embedding) {
      console.log("🔍 Running duplicate search…");

      const { data: matches } = await supabase.rpc(
        "match_tickets",
        {
          query_embedding: embedding,
          condo_filter: condo_id,
          exclude_id: ticket.id,
          created_before: ticket.created_at,
          match_threshold: 0.9,
          match_count: 1,
        }
      );

      console.log("🧪 match_tickets result:", matches);

      if (matches && matches.length > 0) {
        const best = matches[0];

        if (ticket.is_common_area || best.is_common_area) {
          duplicateOf = best.id;
        } else if (
          ticket.unit_id &&
          best.unit_id &&
          ticket.unit_id === best.unit_id
        ) {
          duplicateOf = best.id;
        } else {
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

        console.log("🔁 DUPLICATE CONFIRMED:", duplicateOf ?? "RELATED");
      }
    }

    /* -------------------------------------------------
       5️⃣ RESPONSE
    -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      unit_label,
      unit_id,
      is_duplicate: !!duplicateOf,
      duplicate_of: duplicateOf,
      related_to: relatedTo,
    });
  } catch (err: any) {
    console.error("🔥 Uncaught error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
