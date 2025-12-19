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
   COMMON AREA KEYWORDS (HARD OVERRIDE, MULTI-LANGUAGE)
===================================================== */
const COMMON_AREA_KEYWORDS = [
  // English
  "lift","elevator","lobby","corridor","parking","staircase",
  "guardhouse","garbage","rubbish","trash","bin room","garbage room",

  // Malay
  "rumah sampah","tong sampah","sampah","tempat buang sampah",
  "lif","lobi","koridor","tempat letak kereta","tangga",

  // Mandarin
  "垃圾房","垃圾","垃圾桶","电梯","大堂","走廊","停车场",

  // Tamil
  "குப்பை","குப்பை அறை","லிப்ட்","நடையாலம்","வாகன நிறுத்தம்"
];

function keywordDetectCommonArea(text: string): boolean {
  const lower = text.toLowerCase();
  return COMMON_AREA_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

/* =====================================================
   AI INTENT (USED ONLY IF KEYWORD FAILS)
===================================================== */
async function aiDetectIntent(text: string): Promise<{
  intent: "unit" | "common_area" | "uncertain";
  confidence: number;
}> {
  if (!openai) return { intent: "uncertain", confidence: 0 };

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Classify maintenance issue as unit, common_area, or uncertain. Reply ONLY JSON: {\"intent\":\"\",\"confidence\":0-1}"
      },
      { role: "user", content: text }
    ]
  });

  try {
    const parsed = JSON.parse(resp.choices[0].message.content || "{}");
    return {
      intent: parsed.intent ?? "uncertain",
      confidence: Number(parsed.confidence ?? 0)
    };
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
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const { condo_id, description_raw, phone_number } = body;

    if (!condo_id || !description_raw || !phone_number) {
      return res.status(400).json({
        error: "Missing condo_id, description_raw, or phone_number"
      });
    }

    /* =====================================================
       1️⃣ VERIFY PHONE REGISTRATION (FIXED)
    ===================================================== */
    const normalizedPhone = phone_number.replace(/\D/g, "");

    const { data: resident, error: residentError } = await supabase
      .from("residents")
      .select("unit_id, role")
      .eq("condo_id", condo_id)
      .eq("phone_number", normalizedPhone)
      .maybeSingle();

    if (residentError) {
      console.error("❌ RESIDENT LOOKUP ERROR:", residentError);
      return res.status(500).json({
        error: "Resident lookup failed"
      });
    }

    if (!resident) {
      return res.status(403).json({
        error: "Phone number not registered with management"
      });
    }

    const unit_id = resident.unit_id;
    const isManagement = resident.role === "management";

    /* =====================================================
       2️⃣ INTENT DETECTION (3 LAYERS)
    ===================================================== */
    let is_common_area = false;
    let intent_source = "keyword";
    let intent_confidence = 1;

    // LAYER 1 — HARD KEYWORDS (OVERRIDE EVERYTHING)
    if (keywordDetectCommonArea(description_raw)) {
      is_common_area = true;
      intent_source = "keyword";
      intent_confidence = 1;
    }

    // LAYER 2 — AI (ONLY IF KEYWORDS FAIL)
    else {
      const aiResult = await aiDetectIntent(description_raw);

      if (aiResult.confidence >= 0.75) {
        is_common_area = aiResult.intent === "common_area";
        intent_source = "ai";
        intent_confidence = aiResult.confidence;
      }

      // LAYER 3 — ASK RESIDENT
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

    // MANAGEMENT OVERRIDE
    if (isManagement && !is_common_area) {
      is_common_area = true;
      intent_source = "management_override";
      intent_confidence = 1;
    }

    /* =====================================================
       3️⃣ INSERT TICKET
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
      console.error("❌ TICKET INSERT ERROR:", insertError);
      return res.status(500).json({ error: "Ticket insert failed" });
    }

    /* =====================================================
       4️⃣ EMBEDDING
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
       5️⃣ DUPLICATE / RELATED DETECTION
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

        // HARD DUPLICATE
        if (
          is_common_area ||
          best.is_common_area ||
          (ticket.unit_id && best.unit_id === ticket.unit_id)
        ) {
          duplicate_of = best.id;
        }
        // RELATED ISSUE
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

    /* =====================================================
       6️⃣ RESPONSE
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
    console.error("🔥 UNCAUGHT ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
