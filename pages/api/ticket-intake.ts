import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ================= KEYWORDS ================= */
const COMMON_AREA_KEYWORDS = [
  // English
  "lobby","lift","elevator","parking","corridor","staircase",
  "garbage","trash","bin room","pool","gym",
  // Malay
  "lif","lobi","koridor","tangga","tempat letak kereta",
  "rumah sampah","tong sampah",
  // Mandarin
  "电梯","走廊","停车场","垃圾房","泳池",
  // Tamil
  "லிப்ட்","நடைக்கூடம்","வாகன நிறுத்தம்","குப்பை"
];

const OWN_UNIT_KEYWORDS = [
  "bedroom","bathroom","kitchen","sink",
  "bilik","dapur",
  "房间","厨房",
  "அறை","சமையலறை"
];

// ⚠️ AMBIGUOUS — NEVER AUTO DECIDE
const AMBIGUOUS_KEYWORDS = [
  "toilet","tandas","aircond","air conditioner","ac",
  "厕所","空调","கழிப்பிடம்"
];

function keywordMatch(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/* ================= AI FALLBACK ================= */
async function aiClassify(text: string): Promise<{
  category: "unit" | "common_area" | "mixed" | "uncertain";
  confidence: number;
}> {
  if (!openai) return { category: "uncertain", confidence: 0 };

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Classify maintenance issue as unit, common_area, mixed, or uncertain. Reply ONLY JSON."
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = r.choices[0]?.message?.content;
    const obj = typeof parsed === "string" ? JSON.parse(parsed) : {};

    return {
      category: obj.category ?? "uncertain",
      confidence: Number(obj.confidence ?? 0)
    };
  } catch {
    return { category: "uncertain", confidence: 0 };
  }
}

/* ================= API HANDLER ================= */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { condo_id, phone_number, description_raw } = body;

    if (!condo_id || !phone_number || !description_raw) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    /* ===== 1️⃣ VERIFY RESIDENT ===== */
    const { data: resident } = await supabase
      .from("residents")
      .select("unit_id, approved")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!resident || !resident.approved) {
      return res.status(403).json({
        error: "Phone number not approved by management"
      });
    }

    const unit_id = resident.unit_id;

    /* ===== 2️⃣ INTENT DETECTION ===== */
    let intent_category: "unit" | "common_area" | "mixed" | "uncertain" = "uncertain";
    let intent_source = "keyword";
    let intent_confidence = 1;

    const commonHit = keywordMatch(description_raw, COMMON_AREA_KEYWORDS);
    const unitHit = keywordMatch(description_raw, OWN_UNIT_KEYWORDS);
    const ambiguousHit = keywordMatch(description_raw, AMBIGUOUS_KEYWORDS);

    if (commonHit && unitHit) {
      intent_category = "mixed";
    } else if (commonHit && !ambiguousHit) {
      intent_category = "common_area";
    } else if (unitHit && !ambiguousHit) {
      intent_category = "unit";
    } else {
      const ai = await aiClassify(description_raw);
      if (ai.confidence >= 0.7) {
        intent_category = ai.category;
        intent_confidence = ai.confidence;
        intent_source = "ai";
      }
    }

    /* ===== 3️⃣ CREATE TICKET (ALWAYS) ===== */
    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: intent_category === "unit" ? unit_id : null,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: intent_category === "uncertain" ? "pending_intent" : "new",
        is_common_area: intent_category === "common_area",
        intent_category,
        intent_source,
        intent_confidence,
        diagnosis_fee: intent_category === "unit" ? 30 : 0
      })
      .select()
      .single();

    if (insertError || !ticket) {
      throw insertError;
    }

    /* ===== 4️⃣ ASK INTENT IF UNCERTAIN ===== */
    if (intent_category === "uncertain") {
      await supabase.from("ticket_events").insert({
        ticket_id: ticket.id,
        event_type: "ask_intent",
        event_state: "awaiting_intent",
        payload: {
          phone_number,
          message:
            "This issue could be:\n1️⃣ Your unit\n2️⃣ Common area\n3️⃣ Both\nReply 1, 2 or 3"
        }
      });

      return res.status(202).json({
        pending: true,
        ticket_id: ticket.id
      });
    }

/* ===== 5️⃣ EMBEDDING + DUPLICATE LOGIC (FIXED — NO MATCH COUNT) ===== */
let duplicate_of: string | null = null;
let related_to: string | null = null;

if (openai) {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: description_raw
  });

  const embedding = emb.data[0].embedding;

  await supabase
    .from("tickets")
    .update({ embedding })
    .eq("id", ticket.id);

  const { data: relation, error: relationError } =
    await supabase.rpc("detect_ticket_relation", {
      query_embedding: embedding,
      condo_filter: condo_id,
      ticket_unit_id: ticket.unit_id,
      ticket_is_common_area: ticket.is_common_area,
      exclude_id: ticket.id,
      similarity_threshold: 0.85
    });

  if (relationError) {
    throw relationError;
  }

  if (relation && relation.length > 0) {
    const r = relation[0];

    if (r.relation_type === "hard_duplicate") {
      duplicate_of = r.related_ticket_id;
    } else if (r.relation_type === "related") {
      related_to = r.related_ticket_id;
    }

    await supabase
      .from("tickets")
      .update({
        is_duplicate: !!duplicate_of,
        duplicate_of,
        related_to
      })
      .eq("id", ticket.id);
  }
}


    /* ===== 6️⃣ ASK FOR PHOTO ===== */
    await supabase.from("ticket_events").insert({
      ticket_id: ticket.id,
      event_type: "ask_photo",
      event_state: "awaiting_photo",
      payload: {
        phone_number,
        message: "Do you have photo evidence? Reply YES or NO."
      }
    });

    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      intent_category,
      duplicate_of,
      related_to
    });

  } catch (err: any) {
    console.error("🔥 ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
