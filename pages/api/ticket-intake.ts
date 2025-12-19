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

// ⚠️ AMBIGUOUS — NEVER DECIDE ALONE
const AMBIGUOUS_KEYWORDS = [
  "toilet","tandas","aircond","air conditioner","ac",
  "厕所","空调","கழிப்பிடம்"
];

function keywordMatch(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/* ================= AI FALLBACK (SAFE) ================= */
async function aiClassify(text: string): Promise<{
  category: "unit" | "common_area" | "mixed" | "uncertain";
  confidence: number;
}> {
  if (!openai) return { category: "uncertain", confidence: 0 };

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

  try {
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
  if (req.method !== "POST") return res.status(200).json({ ok: true });

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

    /* ===== 2️⃣ INTENT DETECTION (FIXED) ===== */
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

    /* ===== 3️⃣ ASK USER IF STILL UNCERTAIN ===== */
    if (intent_category === "uncertain") {
      await supabase.from("ticket_events").insert({
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
        message: "Awaiting user intent confirmation"
      });
    }

    /* ===== 4️⃣ INSERT TICKET ===== */
    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: intent_category === "unit" ? unit_id : null,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area: intent_category === "common_area",
        intent_category,
        intent_source,
        intent_confidence,
        diagnosis_fee: intent_category === "unit" ? 30 : 0
      })
      .select()
      .single();

    /* ===== 5️⃣ EMBEDDING + DUPLICATE ===== */
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

      const { data: matches } = await supabase.rpc("match_tickets", {
        query_embedding: embedding,
        condo_filter: condo_id,
        exclude_id: ticket.id,
        match_threshold: 0.85,
        match_count: 1
      });

      if (matches?.length) {
  const best = matches[0];

  // RULE 1️⃣: Common area + common area → HARD DUPLICATE
  if (ticket.is_common_area && best.is_common_area) {
    duplicate_of = best.id;
  }

  // RULE 2️⃣: Same unit → HARD DUPLICATE
  else if (
    !ticket.is_common_area &&
    !best.is_common_area &&
    ticket.unit_id &&
    best.unit_id &&
    ticket.unit_id === best.unit_id
  ) {
    duplicate_of = best.id;
  }

  // RULE 3️⃣: Different units or mixed → RELATED
  else {
    related_to = best.id;
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
    }

    /* ===== 6️⃣ ASK FOR PHOTO ===== */
    await supabase.from("ticket_events").insert({
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
