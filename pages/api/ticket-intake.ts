import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =====================================================
   Clients
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   COMMON AREA KEYWORDS (MULTI-LANGUAGE)
===================================================== */
const COMMON_AREA_KEYWORDS = [
  // English
  "lift", "elevator", "corridor", "staircase", "lobby",
  "parking", "car park", "guard house", "swimming pool",
  "gym", "playground", "rooftop", "management office",

  // Malay
  "lif", "koridor", "tangga", "lobi",
  "tempat letak kereta", "parkir",
  "pondok pengawal", "kolam renang",
  "gim", "taman permainan",

  // Mandarin
  "电梯", "走廊", "楼梯", "大堂",
  "停车场", "保安亭", "游泳池", "健身房", "游乐场",

  // Tamil
  "லிப்ட்", "நடைபாதை", "படிக்கட்டு",
  "வாகனநிலையம்", "நீச்சல் குளம்"
];

/* =====================================================
   KEYWORD DETECTION
===================================================== */
function detectCommonAreaByKeyword(text: string) {
  const normalized = text.toLowerCase();

  for (const keyword of COMMON_AREA_KEYWORDS) {
    if (normalized.includes(keyword.toLowerCase())) {
      return {
        is_common_area: true,
        confidence: 0.95,
        source: "keyword",
        matched: keyword,
      };
    }
  }

  return {
    is_common_area: false,
    confidence: 0,
    source: "keyword",
    matched: null,
  };
}

/* =====================================================
   AI INTENT CLASSIFIER (FALLBACK ONLY)
===================================================== */
async function detectCommonAreaByAI(text: string) {
  if (!openai) return null;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You classify condo maintenance complaints. Reply JSON only.",
      },
      {
        role: "user",
        content: `
Text:
"${text}"

Question:
Is this about a common area?

Rules:
- Respond JSON only
- is_common_area: true or false
- confidence: number between 0 and 1

Example:
{ "is_common_area": true, "confidence": 0.82 }
`,
      },
    ],
  });

  return JSON.parse(response.choices[0].message.content!);
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

    const {
      condo_id,
      description_raw,
      from_phone, // WhatsApp number (E.164)
    } = body;

    if (!condo_id || !description_raw || !from_phone) {
      return res.status(400).json({
        error: "Missing condo_id, description_raw or from_phone",
      });
    }

    /* --------------------------------------------------
       1️⃣ RESOLVE RESIDENT → UNIT
    -------------------------------------------------- */
    const { data: resident, error: residentError } =
      await supabase
        .from("residents")
        .select("unit_id")
        .eq("condo_id", condo_id)
        .eq("phone_number", from_phone)
        .single();

    if (residentError || !resident) {
      return res.status(403).json({
        error: "Phone number not registered with management",
      });
    }

    let unit_id: string | null = resident.unit_id;

    /* --------------------------------------------------
       2️⃣ COMMON AREA DETECTION (HYBRID)
    -------------------------------------------------- */
    let intent = detectCommonAreaByKeyword(description_raw);

    if (!intent.is_common_area && openai) {
      const aiResult = await detectCommonAreaByAI(description_raw);

      if (aiResult && aiResult.confidence >= 0.75) {
        intent = {
          is_common_area: aiResult.is_common_area,
          confidence: aiResult.confidence,
          source: "ai",
          matched: null,
        };
      }
    }

    // If common area → clear unit
    if (intent.is_common_area) {
      unit_id = null;
    }

    /* --------------------------------------------------
       3️⃣ INSERT TICKET
    -------------------------------------------------- */
    const { data: ticket, error: insertError } =
      await supabase
        .from("tickets")
        .insert({
          condo_id,
          unit_id,
          description_raw,
          description_clean: description_raw,
          is_common_area: intent.is_common_area,
          intent_source: intent.source,
          intent_confidence: intent.confidence,
          status: "new",
        })
        .select()
        .single();

    if (insertError || !ticket) {
      throw insertError;
    }

    console.log("✅ Ticket created:", ticket.id);

    /* --------------------------------------------------
       4️⃣ RESPONSE
    -------------------------------------------------- */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      is_common_area: intent.is_common_area,
      intent,
    });
  } catch (err: any) {
    console.error("🔥 ERROR", err);
    return res.status(500).json({
      error: err.message,
    });
  }
}
