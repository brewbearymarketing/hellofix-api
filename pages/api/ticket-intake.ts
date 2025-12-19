import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =====================================================
   CLIENTS
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   COMMON AREA KEYWORDS (HARD RULES – PRIORITY 1)
===================================================== */
const COMMON_AREA_KEYWORDS = [
  // English
  "lift","lobby","corridor","parking","staircase","guardhouse",
  "garbage","rubbish","trash","bin room","garbage room",

  // Malay
  "rumah sampah","tong sampah","sampah",
  "tempat buang sampah","lif","lobi","koridor",
  "tempat letak kereta","tangga",

  // Mandarin
  "垃圾房","垃圾","垃圾桶","电梯","大堂","走廊","停车场",

  // Tamil
  "குப்பை","குப்பை அறை","லிப்ட்","நடையாலம்","வாகன நிறுத்தம்"
];

function isCommonAreaByKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return COMMON_AREA_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

/* =====================================================
   AI INTENT (PRIORITY 2 – ONLY IF KEYWORD FAILS)
===================================================== */
async function aiDetectIntent(text: string): Promise<{
  intent: "unit" | "common_area" | "uncertain";
  confidence: number;
}> {
  if (!openai) return { intent: "uncertain", confidence: 0 };

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Classify maintenance issue as unit or common_area. Reply ONLY JSON: {\"intent\":\"\",\"confidence\":0-1}"
      },
      { role: "user", content: text }
    ]
  });

  try {
    return JSON.parse(response.choices[0].message.content || "{}");
  } catch {
    return { intent: "uncertain", confidence: 0 };
  }
}

/* =====================================================
   API HANDLER
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    console.log("🚀 === TICKET INTAKE START ===");

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { condo_id, description_raw, phone_number } = body;

    if (!condo_id || !description_raw || !phone_number) {
      return res.status(400).json({
        error: "Missing condo_id, description_raw, or phone_number"
      });
    }

    /* =====================================================
       1️⃣ NORMALISE PHONE (CRITICAL FIX)
    ===================================================== */
    const normalizedPhone = phone_number.replace(/\D/g, "");

    /* =====================================================
       2️⃣ RESIDENT LOOKUP (NO .single() BUG)
    ===================================================== */
    const { data: residents, error: residentError } = await supabase
      .from("residents")
      .select("unit_id, role")
      .eq("condo_id", condo_id)
      .eq("phone_number", normalizedPhone);

    if (residentError) {
      console.error("❌ RESIDENT QUERY ERROR:", residentError);
      return res.status(500).json({ error: "Resident lookup failed" });
    }

    if (!residents || residents.length === 0) {
      return res.status(403).json({
        error: "Phone number not registered with management"
      });
    }

    const unit_id = residents[0].unit_id;
    const isManagement = residents.some(r => r.role === "management");

    /* =====================================================
       3️⃣ INTENT DETECTION (3 LAYERS – FIXED)
    ===================================================== */
    let is_common_area = false;
    let intent_source: "keyword" | "ai" | "management" | "confirm";
    let intent_confidence = 1;

    // Layer 1 – KEYWORD (ABSOLUTE)
    if (isCommonAreaByKeyword(description_raw)) {
      is_common_area = true;
      intent_source = "keyword";
      intent_confidence = 1;
    }
    // Layer 2 – AI
    else {
      const aiResult = await aiDetectIntent(description_raw);

      if (aiResult.confidence >= 0.75) {
        is_common_area = aiResult.intent === "common_area";
        intent_source = "ai";
        intent_confidence = aiResult.confidence;
      }
      // Layer 3 – ASK RESIDENT
      else {
        await supabase.from("ticket_events").insert({
          event_type: "awaiting_intent_confirmation",
          payload: {
            phone_number: normalizedPhone,
            message:
              "Is this issue related to:\n1️⃣ Your unit\n2️⃣ Common area\nReply 1 or 2"
          }
        });

        return res.status(202).json({
          pending: true,
          message: "Awaiting resident confirmation"
        });
      }
    }

    // Management override
    if (isManagement) {
      is_common_area = true;
      intent_source = "management";
      intent_confidence = 1;
    }

    /* =====================================================
       4️⃣ INSERT TICKET (ALWAYS)
    ===================================================== */
    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: is_common_area ? null : unit_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area,
        is_duplicate: false,
        intent_source,
        intent_confidence
      })
      .select()
      .single();

    if (insertError || !ticket) {
      throw insertError;
    }

    /* =====================================================
       5️⃣ EMBEDDING (PDPA SAFE)
    ===================================================== */
    let embedding: number[] | null = null;

    if (openai) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_raw
      });

      embedding = emb.data[0].embedding;

      await supabase
        .from("tickets")
        .update({ embedding })
        .eq("id", ticket.id);
    }

    /* =====================================================
       6️⃣ DUPLICATE / RELATED LOGIC
    ===================================================== */
    let duplicate_of: string | null = null;
    let related_to: string | null = null;

    if (embedding) {
      const { data: matches } = await supabase.rpc("match_tickets", {
        query_embedding: embedding,
        condo_filter: condo_id,
        exclude_id: ticket.id,
        match_threshold: 0.85,
        match_count: 1
      });

      if (matches?.length) {
        const best = matches[0];

        if (
          is_common_area ||
          best.is_common_area ||
          (best.unit_id && best.unit_id === ticket.unit_id)
        ) {
          duplicate_of = best.id;
        } else {
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

    /* =====================================================
       7️⃣ RESPONSE
    ===================================================== */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      unit_id: ticket.unit_id,
      is_common_area,
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
