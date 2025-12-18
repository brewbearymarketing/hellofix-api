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
   CONFIG
===================================================== */
const DIAGNOSIS_FEE = 80; // RM
const PLATFORM_COMMISSION = 0.13;
const MANAGEMENT_COMMISSION = 0.02;

/* =====================================================
   COMMON AREA KEYWORDS (MULTI-LANGUAGE)
===================================================== */
const COMMON_AREA_KEYWORDS = [
  // EN
  "lift", "lobby", "corridor", "parking", "staircase", "guardhouse",
  // BM
  "lif", "lobi", "koridor", "tempat letak kereta", "tangga",
  // 中文
  "电梯", "大堂", "走廊", "停车场",
  // தமிழ்
  "லிப்ட்", "நடையாலம்", "வாகன நிறுத்தம்"
];

function detectCommonAreaKeyword(text: string): boolean {
  const t = text.toLowerCase();
  return COMMON_AREA_KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

/* =====================================================
   AI INTENT CLASSIFIER (SAFE)
===================================================== */
async function aiIntent(text: string) {
  if (!openai) return { intent: "uncertain", confidence: 0 };

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Classify maintenance issue as: unit | common_area | uncertain. Respond in JSON: {intent, confidence}"
      },
      { role: "user", content: text }
    ]
  });

  try {
    return JSON.parse(r.choices[0].message.content || "{}");
  } catch {
    return { intent: "uncertain", confidence: 0 };
  }
}

/* =====================================================
   CONTRACTOR AUTO ASSIGNMENT
===================================================== */
async function autoAssignContractor(condo_id: string) {
  const now = new Date().toISOString();

  const { data: contractors } = await supabase
    .from("contractors")
    .select("*")
    .eq("condo_id", condo_id)
    .or(`cooling_off_until.is.null,cooling_off_until.lt.${now}`)
    .order("sla_score", { ascending: false })
    .limit(1);

  return contractors?.[0] ?? null;
}

/* =====================================================
   API HANDLER
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const { condo_id, description_raw, phone_number } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!condo_id || !description_raw || !phone_number) {
      return res.status(400).json({ error: "Missing fields" });
    }

    /* =====================================================
       1️⃣ RESIDENT VALIDATION
    ===================================================== */
    const { data: resident } = await supabase
      .from("residents")
      .select("unit_id")
      .eq("phone_number", phone_number)
      .eq("condo_id", condo_id)
      .single();

    if (!resident) {
      return res.status(403).json({
        error: "Phone number not registered. Management approval required."
      });
    }

    /* =====================================================
       2️⃣ INTENT DETECTION (3 LAYERS)
    ===================================================== */
    let is_common_area = false;
    let intent_source = "keyword";
    let intent_confidence = 1;

    if (detectCommonAreaKeyword(description_raw)) {
      is_common_area = true;
    } else {
      const ai = await aiIntent(description_raw);

      if (ai.confidence >= 0.75) {
        is_common_area = ai.intent === "common_area";
        intent_source = "ai";
        intent_confidence = ai.confidence;
      } else {
        await supabase.from("ticket_events").insert({
          event_type: "awaiting_intent_confirmation",
          payload: {
            phone_number,
            message:
              "Is this issue related to:\n1️⃣ Your unit\n2️⃣ Common area\nReply 1 or 2"
          }
        });

        return res.status(202).json({ pending: true });
      }
    }

    /* =====================================================
       3️⃣ CREATE TICKET
    ===================================================== */
    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: resident.unit_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "diagnosis_pending",
        is_common_area,
        intent_source,
        intent_confidence,
        is_duplicate: false
      })
      .select()
      .single();

    /* =====================================================
       4️⃣ DIAGNOSIS PAYMENT REQUIRED
    ===================================================== */
    await supabase.from("payments").insert({
      ticket_id: ticket.id,
      amount: DIAGNOSIS_FEE,
      status: "pending",
      provider: "whatsapp_pay"
    });

    /* =====================================================
       5️⃣ AUTO ASSIGN CONTRACTOR
    ===================================================== */
    const contractor = await autoAssignContractor(condo_id);

    if (!contractor) {
      return res.status(500).json({
        error: "No contractor available"
      });
    }

    await supabase
      .from("tickets")
      .update({
        auto_assigned_contractor_id: contractor.id,
        status: "diagnosis_paid_waiting_inspection"
      })
      .eq("id", ticket.id);

    /* =====================================================
       6️⃣ DUPLICATE / RELATED
    ===================================================== */
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
        const hardDuplicate =
          is_common_area || best.is_common_area;

        await supabase
          .from("tickets")
          .update({
            is_duplicate: hardDuplicate,
            duplicate_of: hardDuplicate ? best.id : null,
            related_to: hardDuplicate ? null : best.id
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
      contractor_assigned: contractor.id,
      diagnosis_fee: DIAGNOSIS_FEE
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
