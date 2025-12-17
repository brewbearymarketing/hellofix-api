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
   OpenAI client (optional)
===================================================== */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   UNIT EXTRACTION (RULE-BASED, PRODUCTION SAFE)
===================================================== */
async function extractUnitIdFromText(
  condo_id: string,
  text: string
): Promise<{ unit_id: string | null; unit_label: string | null }> {

  console.log("🧪 RAW TEXT:", text);

  // Matches: A-12-3, Block A 12-3, A12-3
  const regex =
    /(block\s*)?([A-Z])\s*[-]?\s*(\d{1,2})\s*[-]?\s*(\d{1,2})/i;

  const match = text.match(regex);
  console.log("🧪 REGEX MATCH:", match);

  if (!match) {
    console.log("⚠️ No unit pattern detected");
    return { unit_id: null, unit_label: null };
  }

  const block = match[2].toUpperCase();
  const num1 = parseInt(match[3], 10);
  const num2 = parseInt(match[4], 10);

  console.log("🧪 PARSED NUMBERS:", { block, num1, num2 });

  // Load condo rules
  const { data: rules, error } = await supabase
    .from("condo_unit_rules")
    .select("*")
    .eq("condo_id", condo_id)
    .single();

  if (error || !rules) {
    console.warn("⚠️ No condo rules found");
    return { unit_id: null, unit_label: null };
  }

  const {
    min_floor,
    max_floor,
    min_unit,
    max_unit,
    format,
  } = rules;

  const num1IsFloor = num1 >= min_floor && num1 <= max_floor;
  const num2IsUnit = num2 >= min_unit && num2 <= max_unit;

  let unit_label: string | null = null;

  // BLOCK-FLOOR-UNIT (A-12-3)
  if (format === "BLOCK-FLOOR-UNIT" && num1IsFloor && num2IsUnit) {
    unit_label = `${block}-${num1}-${num2}`;
  } else {
    console.warn("⚠️ UNIT AMBIGUOUS – NOT AUTO ASSIGNED", {
      block,
      num1,
      num2,
    });
    return { unit_id: null, unit_label: null };
  }

  console.log("✅ NORMALIZED UNIT:", unit_label);

  // Resolve or create unit
  const { data: existingUnit } = await supabase
    .from("units")
    .select("id")
    .eq("condo_id", condo_id)
    .eq("unit_label", unit_label)
    .single();

  if (existingUnit) {
    return { unit_id: existingUnit.id, unit_label };
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
   API HANDLER
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Allow GET for health check
  if (req.method !== "POST") {
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
       1️⃣ Resolve unit (rule-based)
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
       2️⃣ Insert ticket (ALWAYS)
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
      console.error("❌ Ticket insert failed", insertError);
      return res.status(500).json({
        error: insertError?.message || "Ticket insert failed",
      });
    }

    console.log("✅ Ticket inserted:", ticket.id);

    /* -------------------------------------------------
       3️⃣ Create embedding (BEST EFFORT)
    -------------------------------------------------- */
    let embedding: number[] | null = null;

    if (openai) {
      console.log("🧠 Creating embedding...");
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_raw,
      });

      embedding = emb.data[0].embedding;

      console.log("📐 Embedding created:", embedding.length);

      await supabase
        .from("tickets")
        .update({ embedding })
        .eq("id", ticket.id);
    }

    /* -------------------------------------------------
       4️⃣ Duplicate / Related detection
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
          match_threshold: 0.85,
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

        console.log("🔁 DUPLICATE CONFIRMED:", duplicateOf);
      } else {
        console.log("✅ No duplicate found");
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
