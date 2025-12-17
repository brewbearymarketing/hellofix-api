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
   UNIT EXTRACTION (RULE-BASED)
===================================================== */
async function extractUnitIdFromText(
  condo_id: string,
  text: string
): Promise<{ unit_id: string | null; unit_label: string | null }> {
  // Step 1: extract raw pattern
  const match = text.match(
    /(block\s*)?([A-Z])\s*[-]?\s*(\d{1,2})\s*[-]?\s*(\d{1,2})/i
  );

  if (!match) return { unit_id: null, unit_label: null };

  const block = match[2].toUpperCase();
  const a = parseInt(match[3], 10);
  const b = parseInt(match[4], 10);

  // Step 2: load condo rules
  const { data: rules } = await supabase
    .from("condo_unit_rules")
    .select("*")
    .eq("condo_id", condo_id)
    .single();

  if (!rules) return { unit_id: null, unit_label: null };

  const {
    min_floor,
    max_floor,
    min_unit,
    max_unit,
    format,
  } = rules;

  const aIsFloor = a >= min_floor && a <= max_floor;
  const bIsUnit = b >= min_unit && b <= max_unit;
  const bIsFloor = b >= min_floor && b <= max_floor;
  const aIsUnit = a >= min_unit && a <= max_unit;

  let unit_label: string | null = null;

  if (format === "BLOCK-FLOOR-UNIT" && aIsFloor && bIsUnit) {
    unit_label = `${block}-${a}-${b}`;
  } else if (format === "BLOCK-UNIT-FLOOR" && aIsUnit && bIsFloor) {
    unit_label = `${block}-${b}-${a}`;
  } else if (aIsFloor && bIsUnit && !(aIsUnit && bIsFloor)) {
    unit_label = `${block}-${a}-${b}`;
  } else if (bIsFloor && aIsUnit && !(bIsUnit && aIsFloor)) {
    unit_label = `${block}-${b}-${a}`;
  } else {
    // ambiguous → DO NOT AUTO-ASSIGN
    return { unit_id: null, unit_label: null };
  }

  // Step 3: resolve or create unit
  const { data: unit } = await supabase
    .from("units")
    .select("id")
    .eq("condo_id", condo_id)
    .eq("unit_label", unit_label)
    .single();

  if (unit) {
    return { unit_id: unit.id, unit_label };
  }

  const { data: newUnit } = await supabase
    .from("units")
    .insert({ condo_id, unit_label })
    .select()
    .single();

  return {
    unit_id: newUnit?.id ?? null,
    unit_label,
  };
}

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
       1️⃣ Resolve unit (text → rule → UUID)
    -------------------------------------------------- */
    let unit_id: string | null = null;
    let unit_label: string | null = null;

    if (!is_common_area) {
      const result = await extractUnitIdFromText(
        condo_id,
        description_raw
      );
      unit_id = result.unit_id;
      unit_label = result.unit_label;
    }

    /* -------------------------------------------------
       2️⃣ Insert ticket
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

    /* -------------------------------------------------
       3️⃣ Create embedding
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
    }

    /* -------------------------------------------------
       4️⃣ Duplicate / related logic
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
          match_threshold: 0.9,
          match_count: 1,
        }
      );

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
      }
    }

    /* -------------------------------------------------
       5️⃣ Response
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
    console.error("🔥 Uncaught error", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
