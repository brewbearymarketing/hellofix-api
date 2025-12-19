import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =====================================================
   SUPABASE CLIENT
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* =====================================================
   OPENAI (OPTIONAL)
===================================================== */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =====================================================
   SAFE PHONE NORMALIZATION (NO CRASH)
===================================================== */
function normalizePhone(input: unknown): string {
  if (!input) return "";

  let raw = "";

  if (typeof input === "string") {
    raw = input;
  } else if (typeof input === "object") {
    if (Array.isArray(input)) {
      raw = String(input[0] ?? "");
    } else if ((input as any).number) {
      raw = String((input as any).number);
    } else {
      raw = JSON.stringify(input);
    }
  } else {
    raw = String(input);
  }

  // remove everything except digits
  let digits = raw.replace(/\D/g, "");

  // normalize Malaysia
  if (digits.startsWith("0")) {
    digits = "6" + digits;
  }

  if (digits.startsWith("60")) {
    return digits;
  }

  return digits;
}

/* =====================================================
   COMMON AREA KEYWORDS (HARD RULE)
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

function keywordDetectCommonArea(text: string): boolean {
  const lower = text.toLowerCase();
  return COMMON_AREA_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
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
       1️⃣ NORMALIZE PHONE
    ===================================================== */
    const normalizedPhone = normalizePhone(phone_number);

    console.log("📞 RAW PHONE:", phone_number);
    console.log("📞 NORMALIZED PHONE:", normalizedPhone);

    /* =====================================================
       2️⃣ LOOKUP RESIDENT (NO FALSE 403)
    ===================================================== */
    const { data: resident, error: residentError } = await supabase
      .from("residents")
      .select("unit_id, role, phone_number")
      .eq("condo_id", condo_id)
      .eq("phone_number", normalizedPhone)
      .maybeSingle();

    console.log("👤 RESIDENT RESULT:", resident);
    console.log("👤 RESIDENT ERROR:", residentError);

    if (residentError) {
      return res.status(500).json({
        error: "Resident lookup failed",
        detail: residentError.message
      });
    }

    if (!resident) {
      return res.status(403).json({
        error: "Phone number not registered with management",
        phone_used: normalizedPhone
      });
    }

    const unit_id = resident.unit_id;
    const isManagement = resident.role === "management";

    /* =====================================================
       3️⃣ INTENT DETECTION (KEYWORD FIRST)
    ===================================================== */
    let is_common_area = false;
    let intent_source = "keyword";
    let intent_confidence = 1;

    if (keywordDetectCommonArea(description_raw)) {
      is_common_area = true;
    }

    // management override
    if (isManagement) {
      is_common_area = true;
      intent_source = "management_override";
      intent_confidence = 1;
    }

    /* =====================================================
       4️⃣ INSERT TICKET
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
      console.error("❌ Ticket insert failed:", insertError);
      return res.status(500).json({ error: "Ticket insert failed" });
    }

    console.log("✅ TICKET CREATED:", ticket.id);

    /* =====================================================
       5️⃣ RESPONSE (NO EMBEDDING YET – STABLE BASE)
    ===================================================== */
    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      unit_id: ticket.unit_id,
      is_common_area
    });

  } catch (err: any) {
    console.error("🔥 UNCAUGHT ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
