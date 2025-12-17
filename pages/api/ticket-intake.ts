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
   UNIT EXTRACTION (ALWAYS RUNS)
===================================================== */
async function extractUnitIdFromText(
  condo_id: string,
  text: string
): Promise<{ unit_id: string | null; unit_label: string | null }> {
  console.log("🧪 RAW TEXT:", text);

  const match = text.match(
    /(block\s*)?([A-Z])\s*[-\/]?\s*(\d{1,2})\s*[-\/]?\s*(\d{1,2})/i
  );

  console.log("🧪 REGEX MATCH:", match);

  if (!match) {
    console.warn("⚠️ NO UNIT PATTERN FOUND");
    return { unit_id: null, unit_label: null };
  }

  const block = match[2].toUpperCase();
  const a = parseInt(match[3], 10);
  const b = parseInt(match[4], 10);

  console.log("🧪 PARSED NUMBERS:", { a, b });

  const { data: rules } = await supabase
    .from("condo_unit_rules")
    .select("*")
    .eq("condo_id", condo_id)
    .single();

  console.log("🧪 RULES FOUND:", rules);

  if (!rules) {
    console.warn("⚠️ NO CONDO RULES FOUND");
    return { unit_id: null, unit_label: null };
  }

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
    console.warn("⚠️ UNIT AMBIGUOUS – NOT ASSIGNED", { a, b, rules });
    return { unit_id: null, unit_label: null };
  }

  console.log("✅ NORMALIZED UNIT:", unit_label);

  const { data: unit } = await supabase
    .from("units")
    .select("id")
    .eq("condo_id", condo_id)
    .eq("unit_label", unit_label)
    .single();

  if (unit) {
    console.log("✅ EXISTING UNIT FOUND:", unit.id);
    return { unit_id: unit.id, unit_label };
  }

  const { data: newUnit } = await supabase
    .from("units")
    .insert({ condo_id, unit_label })
    .select()
    .single();

  console.log("🆕 NEW UNIT CREATED:", newUnit?.id);

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

    const { condo_id, description_raw, is_common_area } = body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* -------------------------------------------------
       1️⃣ ALWAYS attempt unit extraction
    -------------------------------------------------- */
    console.log("🏠 Attempting unit extraction...");

    const unitResult = await extractUnitIdFromText(
      condo_id,
      description_raw
    );

    const unit_id = unitResult.unit_id;
    const unit_label = unitResult.unit_label;

    console.log("🏠 Unit extraction result:", {
      unit_id,
      unit_label,
    });

    /* -------------------------------------------------
       2️⃣ Insert ticket
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
        is_common_area: is_common_area === true,
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
       3️⃣ Create embedding
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
