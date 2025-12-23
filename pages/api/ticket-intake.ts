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

console.log("OPENAI ENABLED:", !!openai);

/* ================= KEYWORDS ================= */
const COMMON_AREA_KEYWORDS = [
  "lobby","lift","elevator","parking","corridor","staircase",
  "garbage","trash","bin room","pool","gym",
  "lif","lobi","koridor","tangga","tempat letak kereta",
  "rumah sampah","tong sampah",
  "电梯","走廊","停车场","垃圾房","泳池",
  "லிப்ட்","நடைக்கூடம்","வாகன நிறுத்தம்","குப்பை"
];

const OWN_UNIT_KEYWORDS = [
  "bedroom","bathroom","kitchen","sink",
  "bilik","dapur",
  "房间","厨房",
  "அறை","சமையலறை"
];

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
            "Classify maintenance issue as unit, common_area, mixed, or uncertain. Reply ONLY JSON: {category, confidence}"
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const raw = r.choices[0]?.message?.content;
    const obj = typeof raw === "string" ? JSON.parse(raw) : {};

    return {
      category: obj.category ?? "uncertain",
      confidence: Number(obj.confidence ?? 0)
    };
  } catch {
    return { category: "uncertain", confidence: 0 };
  }
}

/* ================= 🔹 ADDED: TRANSCRIPT CLEANER ================= */
function cleanTranscript(text: string): string {
  if (!text) return text;

  let t = text.toLowerCase();

  // remove filler words (multilingual)
  t = t.replace(
    /\b(uh|um|erm|err|ah|eh|lah|lor|meh|macam|seperti|kinda|sort of)\b/g,
    ""
  );

  // remove repeated words (e.g. "bocor bocor bocor")
  t = t.replace(/\b(\w+)(\s+\1\b)+/g, "$1");

  // normalize spaces
  t = t.replace(/\s+/g, " ").trim();

  // capitalize first letter
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ================= 🔹 ADDED: VOICE TRANSCRIPTION ================= */

import { toFile } from "openai/uploads";

async function transcribeVoice(url: string): Promise<string | null> {
  if (!openai) return null;

  try {
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const audioRes = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    if (!audioRes.ok) {
      console.error("TWILIO FETCH FAILED:", audioRes.status);
      return null;
    }

    const audioBuffer = await audioRes.arrayBuffer();

    const file = await toFile(
      Buffer.from(audioBuffer),
      "voice.ogg",
      { type: "audio/ogg" }
    );

    const transcript = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1"
    });

    return transcript.text || null;

  } catch (err) {
    console.error("VOICE TRANSCRIPTION ERROR:", err);
    return null;
  }
}



/* ================= 🔹 ADDED: MESSAGE NORMALIZER ================= */
async function normalizeIncomingMessage(body: any): Promise<string> {
  let text = body.description_raw ?? "";

  // voice first
  if (!text && body.voice_url) {
    const transcript = await transcribeVoice(body.voice_url);
    if (transcript) text = transcript;
  }

  // photo-only fallback
  if (!text && body.image_url) {
    text = "Photo evidence provided. Issue description pending.";
  }

  // 🔹 CLEAN TRANSCRIPT BEFORE ANY AI / EMBEDDING
  return cleanTranscript(text);
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
    const { condo_id, phone_number } = body; 
    const description_raw = await normalizeIncomingMessage(body); 
    if (!condo_id || !phone_number || !description_raw)  {
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
    let intent_source: "keyword" | "ai" | "none" = "none";
    let intent_confidence = 1;

    const commonHit = keywordMatch(description_raw, COMMON_AREA_KEYWORDS);
    const unitHit = keywordMatch(description_raw, OWN_UNIT_KEYWORDS);
    const ambiguousHit = keywordMatch(description_raw, AMBIGUOUS_KEYWORDS);

    if (commonHit && unitHit) {
      intent_category = "mixed";
      intent_source = "keyword";
    } else if (commonHit && !ambiguousHit) {
      intent_category = "common_area";
      intent_source = "keyword";
    } else if (unitHit && !ambiguousHit) {
      intent_category = "unit";
      intent_source = "keyword";
    } else {
      const ai = await aiClassify(description_raw);
      if (ai.confidence >= 0.7) {
        intent_category = ai.category;
        intent_confidence = ai.confidence;
        intent_source = "ai";
      }
    }

    /* ===== 3️⃣ CREATE TICKET ===== */
    const { data: ticket, error } = await supabase
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

    if (error || !ticket) throw error;

    /* ===== 4️⃣ EMBEDDING + DUPLICATE ===== */
    let duplicate_of: string | null = null;
    let related_to: string | null = null;

    if (openai) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_raw
      });

      const embedding = emb.data[0].embedding;

      await supabase.from("tickets").update({ embedding }).eq("id", ticket.id);

      const { data: relation } = await supabase.rpc(
        "detect_ticket_relation",
        {
          query_embedding: embedding,
          condo_filter: condo_id,
          ticket_unit_id: ticket.unit_id,
          ticket_is_common_area: ticket.is_common_area,
          exclude_id: ticket.id,
          similarity_threshold: 0.85
        }
      );

      if (relation?.length) {
        const r = relation[0];
        if (r.relation_type === "hard_duplicate") duplicate_of = r.related_ticket_id;
        if (r.relation_type === "related") related_to = r.related_ticket_id;

        await supabase.from("tickets").update({
          is_duplicate: !!duplicate_of,
          duplicate_of,
          related_to
        }).eq("id", ticket.id);
      }
    }

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
