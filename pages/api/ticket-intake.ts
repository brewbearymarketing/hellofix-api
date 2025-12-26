import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ================= TYPES ================= */

type Lang = "en" | "ms" | "zh" | "ta";

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
  "bedroom","bathroom","kitchen","sink","house toilet","room toilet",
  "master toilet","house bathroom","house lamp","room lamp",
  "bilik","dapur","tandas rumah","tandas bilik","tandas master",
  "bilik air rumah","lampu rumah","lampu bilik",
  "房间","厨房","房屋厕所","房间厕所","主厕所","房屋浴室","屋灯","房间灯",
  "அறை","சமையலறை"
];

const AMBIGUOUS_KEYWORDS = [
  "toilet","tandas","aircond","air conditioner","ac","lamp","lampu",
  "厕所","空调","கழிப்பிடம்","चिराग","灯"
];

function keywordMatch(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/* ================= AI CLASSIFIER ================= */
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

/* ================= MALAYSIAN AI NORMALISER ================= */
async function aiCleanDescription(text: string): Promise<string> {
  if (!openai) return text;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
You are a Malaysian property maintenance assistant.

Rewrite the issue into ONE short, clear maintenance sentence in English.

Rules:
- Remove filler words (lah, lor, leh, ah, eh).
- Translate Malaysian slang / rojak into standard English.
- Translate Malay / Chinese / Tamil words if present.
- Keep ONLY the asset + problem + location if mentioned.
- No emojis. No apologies. No extra words.
- Do NOT guess causes. Do NOT add solutions.

Examples:
"aircond rosak tak sejuk bilik master" → "Master bedroom air conditioner not cooling"
"paip bocor bawah sink dapur" → "Kitchen sink pipe leaking"
"lift rosak tingkat 5" → "Elevator malfunction at level 5"
"lampu koridor level 3 tak nyala" → "Corridor light not working at level 3"
`
        },
        { role: "user", content: text }
      ]
    });

    return r.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

/* ================= LANGUAGE DETECTOR ================= */
function detectLanguage(text: string): "en" | "ms" | "zh" | "ta" {
  if (!text) return "en";

  const t = text.toLowerCase().trim();

  /* ========= SCRIPT-BASED (MOST RELIABLE) ========= */

  // Mandarin (Chinese)
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";

  // Hindi (Devanagari)
  if (/[\u0900-\u097F]/.test(text)) return "ta";

  /* ========= GREETING-BASED ========= */

  // Malay greetings
  if (
    t === "hai" ||
    t === "salam" ||
    t === "assalamualaikum" ||
    t === "assalamu alaikum"
  ) {
    return "ms";
  }

  // Mandarin greetings (romanized + native)
  if (
    t === "ni hao" ||
    t === "你好" ||
    t === "您好"
  ) {
    return "zh";
  }

  // Hindi greetings
  if (
    t === "namaste" ||
    t === "namaskar" ||
    t === "नमस्ते"
  ) {
    return "ta";
  }

  /* ========= CONTENT-BASED ========= */

  // Malay keywords
  if (
    t.includes("bocor") ||
    t.includes("rosak") ||
    t.includes("tandas") ||
    t.includes("lampu") ||
    t.includes("tak") ||
    t.includes("nak") ||
    t.includes("tolong")
  ) {
    return "ms";
  }

  // Default → English
  return "en";
}

/* ================= WHATSAPP NOISE STRIPPER (NEW, REQUIRED) ================= */
function stripWhatsAppNoise(text: string): string {
  return text
    .replace(/[0-9️⃣•\-–—]/g, " ")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* ================= AUTO REPLIES ================= */
const AUTO_REPLIES = {
  greeting: {
    en: "Hi 👋 Please describe the issue you are facing.",
    ms: "Hai 👋 Sila terangkan masalah yang anda hadapi.",
    zh: "你好 👋 请描述您遇到的问题。",
    ta: "வணக்கம் 👋 நீங்கள் எதிர்கொள்ளும் பிரச்சினையை விவரிக்கவும்."
  },
  ticketCreated: {
    en: "✅ Your issue has been reported. We will assign a contractor shortly.",
    ms: "✅ Aduan anda telah direkodkan. Kontraktor akan ditugaskan sebentar lagi.",
    zh: "✅ 您的问题已记录。",
    ta: "✅ உங்கள் புகார் பதிவு செய்யப்பட்டது."
  },
  duplicateNotice: {
    en: "⚠️ A similar issue was reported earlier. We’ve linked your report.",
    ms: "⚠️ Isu serupa telah dilaporkan sebelum ini.",
    zh: "⚠️ 检测到类似问题，已为您关联。",
    ta: "⚠️ இதே போன்ற பிரச்சினை முன்பு பதிவு செய்யப்பட்டுள்ளது."
  }
};

/* ================= GREETING GUARD ================= */
function isGreetingOnly(text: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase().trim();
  return ["hi","hello","hey","hai","yo","salam","test","ping"].includes(t);
}

/* ================= CLEANER ================= */
function cleanTranscript(text: string): string {
  if (!text) return text;
  let t = text.toLowerCase();
  t = t.replace(/\b(uh|um|ah|eh|lah|lor)\b/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ================= VOICE ================= */
async function transcribeVoice(mediaUrl: string): Promise<string | null> {
  if (!openai) return null;

  try {
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const res = await fetch(mediaUrl, {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    const file = await toFile(Buffer.from(buffer), "voice");

    const transcript = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1"
    });

    return transcript.text ?? null;
  } catch {
    return null;
  }
}

/* ================= NORMALIZER ================= */
async function normalizeIncomingMessage(body: any): Promise<string> {
  let text: string = body.description_raw || "";

  if (!text && body.voice_url) {
    const transcript = await transcribeVoice(body.voice_url);
    if (transcript) text = transcript;
  }

  if (!text && body.image_url) {
    text = "Photo evidence provided.";
  }

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
    const description_clean = await aiCleanDescription(description_raw);

    // ✅ CRITICAL FIX: detect language from RAW WhatsApp text
const rawText =
  typeof body.description_raw === "string"
    ? body.description_raw
    : "";

const rawForLang = stripWhatsAppNoise(rawText);
const detectedLang = detectLanguage(rawForLang);

    if (!condo_id || !phone_number) {
      return res.status(400).json({ error: "Missing required fields" });
    }

     /* ===== VERIFY RESIDENT ===== */
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

       /* ================= SESSION ================= */
    let { data: session } = await supabase
      .from("conversation_sessions")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!session) {
      const { data } = await supabase
        .from("conversation_sessions")
        .insert({
          condo_id,
          phone_number,
          state: "idle"
        })
        .select()
        .single();
      session = data;
    }
    
    async function updateSession(
  sessionId: string,
  fields: Record<string, any>
) {
  await supabase
    .from("conversation_sessions")
    .update({
      ...fields,
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId);
}
 

/* ===== INTENT DETECTION (FIXED) ===== */
let intent_category: "unit" | "common_area" | "mixed" | "uncertain" = "uncertain";
let intent_source: "keyword" | "ai" | "none" = "none";
let intent_confidence = 1;
const textForIntent = description_clean.toLowerCase();

const commonHit = keywordMatch(textForIntent, COMMON_AREA_KEYWORDS);
const unitHit = keywordMatch(textForIntent, OWN_UNIT_KEYWORDS);
const ambiguousHit = keywordMatch(textForIntent, AMBIGUOUS_KEYWORDS);

// 🔑 RULE ORDER (IMPORTANT)
if (unitHit && commonHit) {
  intent_category = "mixed";
  intent_source = "keyword";

} else if (unitHit) {
  // ✅ unit overrides ambiguous
  intent_category = "unit";
  intent_source = "keyword";

} else if (commonHit) {
  intent_category = "common_area";
  intent_source = "keyword";

} else if (ambiguousHit) {
  // ✅ ambiguous defaults to UNIT
  intent_category = "unit";
  intent_source = "keyword";

} else {
  const ai = await aiClassify(description_clean);
  if (ai.confidence >= 0.7) {
    intent_category = ai.category;
    intent_confidence = ai.confidence;
    intent_source = "ai";
  }
}

    /* ================= GREETING ================= */
if (session.state === "idle" && isPureGreeting(rawText)) {
  await supabase
    .from("conversation_sessions")
    .update({
      state: "greeted",
      language: detectedLang,
      updated_at: new Date().toISOString()
    })
    .eq("id", session.id);

  return res.status(200).json({
    reply: AUTO_REPLIES.greeting[detectedLang]
  });
}
    
    function isPureGreeting(text: string): boolean {
  if (!text) return true;

  const t = stripWhatsAppNoise(text);

  // common greeting patterns
  const greetingPatterns = [
    /^hi+$/,
    /^hello+$/,
    /^hey+$/,
    /^hai+$/,
    /^helo+$/,
    /^yo+$/,
    /^salam$/,
    /^ass?alamualaikum$/,
    /^👋+$/,
    /^wave$/,
  ];

  // if matches greeting pattern AND no maintenance keywords
  const isGreetingWord = greetingPatterns.some(r => r.test(t));

  const hasMaintenanceSignal =
    keywordMatch(t, COMMON_AREA_KEYWORDS) ||
    keywordMatch(t, OWN_UNIT_KEYWORDS) ||
    keywordMatch(t, AMBIGUOUS_KEYWORDS) ||
    t.includes("bocor") ||
    t.includes("rosak") ||
    t.includes("leak") ||
    t.includes("broken");

  return isGreetingWord && !hasMaintenanceSignal;
}

    /* ================= LOCK LANGUAGE AFTER GREETING ================= */
    if (!session.language) {
      await supabase
        .from("conversation_sessions")
        .update({ language: detectedLang })
        .eq("id", session.id);

      session.language = detectedLang;
    }

    const lang =
  (session.language as "en" | "ms" | "zh" | "ta") || detectedLang;

    reply: AUTO_REPLIES.ticketCreated[lang]
    reply: AUTO_REPLIES.duplicateNotice[lang]

    /* ================= START DRAFT ================= */
if (session.state === "greeted") {
  await supabase
    .from("conversation_sessions")
    .update({
      state: "drafting",
      draft_description: description_clean,
      updated_at: new Date().toISOString()
    })
    .eq("id", session.id);

  return res.status(200).json({
    reply:
      lang === "ms"
        ? `Saya faham masalah berikut:\n\n"${description_clean}"\n\nBalas:\n1️⃣ Sahkan\n2️⃣ Edit`
        : `I understood the issue as:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
  });
}

    /* ================= EDIT DRAFT ================= */
if (session.state === "drafting" && rawText === "2") {
  return res.status(200).json({
    reply:
      lang === "ms"
        ? "Baik 👍 Sila taip semula masalah anda."
        : "Okay 👍 Please retype your issue."
  });
}

if (session.state === "drafting" && rawText !== "1") {
  await supabase
    .from("conversation_sessions")
    .update({
      draft_description: description_clean,
      updated_at: new Date().toISOString()
    })
    .eq("id", session.id);

  return res.status(200).json({
    reply:
      lang === "ms"
        ? `Kemaskini draf:\n\n"${description_clean}"\n\nBalas:\n1️⃣ Sahkan\n2️⃣ Edit`
        : `Updated draft:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
  });
}

    /* ================= CONFIRM & CREATE TICKET ================= */
let ticket: any = null;

if (session.state === "drafting" && rawText === "1") {
  const finalDescription = session.draft_description;

  const { data, error } = await supabase
    .from("tickets")
    .insert({
      condo_id,
      unit_id: intent_category === "unit" ? unit_id : null,
      description_raw: finalDescription,
      description_clean: finalDescription,
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

  if (error || !data) throw error;

  ticket = data; // ✅ assign to outer variable

  await supabase
    .from("conversation_sessions")
    .update({
      state: "ticket_created",
      current_ticket_id: ticket.id,
      draft_description: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", session.id);

  return res.status(200).json({
    reply: AUTO_REPLIES.ticketCreated[lang],
    ticket_id: ticket.id
  });
}

    /* ================= DUPLICATE DETECTION ================= */
    let duplicate_of: string | null = null;
    let related_to: string | null = null;

    if (openai && description_raw) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_raw
      });

      const embedding = emb.data[0].embedding;

      await supabase
        .from("tickets")
        .update({ embedding })
        .eq("id", ticket.id);

      const { data: relation } = await supabase.rpc(
        "detect_ticket_relation",
        {
          query_embedding: embedding,
          condo_filter: condo_id,
          ticket_unit_id: null,
          ticket_is_common_area: false,
          exclude_id: ticket.id,
          similarity_threshold: 0.85
        }
      );

      if (relation?.length) {
        const r = relation[0];
        duplicate_of =
          r.relation_type === "hard_duplicate"
            ? r.related_ticket_id
            : null;
        related_to =
          r.relation_type === "related"
            ? r.related_ticket_id
            : null;

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

    return res.status(200).json({
      reply: duplicate_of
        ? AUTO_REPLIES.duplicateNotice[lang]
        : AUTO_REPLIES.ticketCreated[lang],
      ticket_id: ticket.id
    });

  } catch (err: any) {
    console.error("🔥 ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
