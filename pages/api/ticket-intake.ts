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
   OpenAI client
===================================================== */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   Keyword detection
===================================================== */
const COMMON_AREA_KEYWORDS = [
  "lobby","lift","elevator","parking","corridor","staircase",
  "pool","gym","guard house","management office",
  "lif","tempat letak kereta","koridor","tangga",
  "kolam","gim","pejabat pengurusan","pondok pengawal",
  "电梯","停车场","走廊","楼梯","泳池","健身房","管理处",
  "லிப்ட்","வாகன நிறுத்தம்","நடைக்கூடம்","படிக்கட்டு",
  "நீச்சல் குளம்","உடற்பயிற்சி கூடம்"
];

function keywordDetectCommonArea(text: string): boolean {
  const t = text.toLowerCase();
  return COMMON_AREA_KEYWORDS.some(k => t.includes(k));
}

/* =====================================================
   AI classification fallback
===================================================== */
async function aiDetectCommonArea(text: string) {
  if (!openai) return { is_common_area: false, confidence: 0 };

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Reply in JSON only." },
      {
        role: "user",
        content:
          `Is this a common area maintenance issue?
           Return JSON: { "is_common_area": boolean, "confidence": number }.
           Text: ${text}`
      }
    ],
    response_format: { type: "json_object" }
  });

  return JSON.parse(res.choices[0].message.content || "{}");
}

/* =====================================================
   API handler
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const { condo_id, phone_number, description_raw } = body;

    if (!condo_id || !phone_number || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id, phone_number or description_raw"
      });
    }

    /* -------------------------------------------------
       1️⃣ Resolve resident unit (SOURCE OF TRUTH)
    -------------------------------------------------- */
    const { data: resident } = await supabase
      .from("residents")
      .select("unit_id")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .single();

    const unit_id = resident?.unit_id ?? null;

    /* -------------------------------------------------
       2️⃣ Determine common area
    -------------------------------------------------- */
    let is_common_area = keywordDetectCommonArea(description_raw);
    let intent_confidence = 1;

    if (!is_common_area) {
      const ai = await aiDetectCommonArea(description_raw);
      if (ai?.confidence >= 0.7) {
        is_common_area = ai.is_common_area;
        intent_confidence = ai.confidence;
      }
    }

    /* -------------------------------------------------
       3️⃣ Insert ticket FIRST
    -------------------------------------------------- */
    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area,
        intent_confidence
      })
      .select()
      .single();

    /* -------------------------------------------------
       4️⃣ Embedding + duplicate detection
    -------------------------------------------------- */
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

      const { data: matches } = await supabase.rpc(
        "match_tickets",
        {
          query_embedding: embedding,
          condo_filter: condo_id,
          exclude_id: ticket.id,
          created_before: ticket.created_at,
          match_threshold: 0.85,
          match_count: 1
        }
      );

      if (matches?.length) {
        const best = matches[0];

        if (
          ticket.is_common_area ||
          best.is_common_area ||
          (ticket.unit_id && best.unit_id && ticket.unit_id === best.unit_id)
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

    /* -------------------------------------------------
       5️⃣ WhatsApp confirmation trigger
    -------------------------------------------------- */
    const needs_confirmation =
      !unit_id || intent_confidence < 0.7;

    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      unit_id,
      is_common_area,
      needs_confirmation,
      duplicate_of,
      related_to
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
