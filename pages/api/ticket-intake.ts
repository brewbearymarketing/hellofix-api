 /*=====no voice (need to patch later) but language detect work, greeting hi blocked======*/

import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";



/*==== FOR AUDIO UPLOAD TO OPENAI=======*/
import { toFile } from "openai/uploads";

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/*==================DETECT INTENT TO COMPLAINT=================*/
function hasProblemSignal(text: string): boolean {
  const t = stripWhatsAppNoise(text);

  return (
    keywordMatch(t, COMMON_AREA_KEYWORDS) ||
    keywordMatch(t, OWN_UNIT_KEYWORDS) ||
    keywordMatch(t, AMBIGUOUS_KEYWORDS) ||
    t.includes("bocor") ||
    t.includes("rosak") ||
    t.includes("leak") ||
    t.includes("broken") ||
    t.includes("not working") ||
    t.includes("tak") ||
    t.includes("cannot") ||
    t.includes("problem")
  );
}

/* ================= KEYWORDS MATCH ================= */
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

/* ================= AI CLASSIFIER UNIT/COMMON/MIXED ================= */
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

/* ================= MALAYSIAN AI NORMALISER / CLEANER FOR TEXT, AUDIO AND IMAGE AND DUPLICATE PRE REQUIREMENT ================= */
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

  // Tamil (Malaysia)
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta";

  /* ========= GREETING-BASED (LESS RELIABLE) ========= */

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

/* ================= NORMALIZER FOR VOICE ================= */
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


/*======================ABOVE THIS LINE 🧰 Tools, rules, and helpers that wont auto executed==========*/

/* ================= API HANDLER (HANDLE ALL LOGIC LIKE WAITER IN RESTAURANT)================= */
/* ================= API HANDLER ================= */
async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("🚀 [HANDLER] Incoming request");

  if (req.method !== "POST") {
    console.log("ℹ️ [HANDLER] Non-POST request ignored");
    return res.status(200).json({ ok: true });
  }

  try {
    /* ================= 0. PARSE ================= */
    console.log("🧩 [0] Parsing body");
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { condo_id, phone_number } = body;
    console.log("🧩 [0] condo_id:", condo_id, "phone_number:", phone_number);

    if (!condo_id || !phone_number) {
      console.log("❌ [0] Missing required fields");
      return res.status(400).json({ error: "Missing required fields" });
    }

    /* ================= 1. RAW MESSAGE ================= */
    console.log("✉️ [1] Normalizing incoming message");
    const description_raw = await normalizeIncomingMessage(body);
    const description_clean = await aiCleanDescription(description_raw);

    console.log("✉️ [1] description_raw:", description_raw);
    console.log("✉️ [1] description_clean:", description_clean);

    const rawText =
      typeof body.description_raw === "string" ? body.description_raw : "";

    const stripped = stripWhatsAppNoise(rawText);
    const detectedLang = detectLanguage(stripped);

    console.log("🌐 [1] rawText:", rawText);
    console.log("🌐 [1] stripped:", stripped);
    console.log("🌐 [1] detectedLang:", detectedLang);

    /* ================= 2. FETCH OR CREATE SESSION ================= */
    console.log("🗂️ [2] Fetching session");
    let { data: session } = await supabase
      .from("conversation_sessions")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!session) {
      console.log("🆕 [2] Creating new session");
      const { data } = await supabase
        .from("conversation_sessions")
        .insert({
          condo_id,
          phone_number,
          state: "idle",
          language: detectedLang
        })
        .select()
        .single();

      session = data;
    }

    if (!session || !session.id) {
      console.log("❌ [2] Session invalid");
      throw new Error("Session invalid");
    }

    console.log("🗂️ [2] Session state:", session.state);

    async function updateSession(fields: Record<string, any>) {
      console.log("📝 [SESSION UPDATE]", fields);
      await supabase
        .from("conversation_sessions")
        .update({
          ...fields,
          updated_at: new Date().toISOString()
        })
        .eq("id", session.id);
    }

    /* ================= 3. VERIFY RESIDENT ================= */
    console.log("👤 [3] Verifying resident");
    const { data: resident } = await supabase
      .from("residents")
      .select("unit_id, approved")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!resident || !resident.approved) {
      console.log("❌ [3] Resident not approved");
      return res.status(403).json({
        error: "Phone number not approved by management"
      });
    }

    const unit_id = resident.unit_id;
    console.log("👤 [3] Resident verified, unit_id:", unit_id);

    /* ================= 4. GREETING / NOISE HARD BLOCK ================= */
    console.log("👋 [4] Checking greeting/noise block");
    if (session.state === "idle" && !hasProblemSignal(rawText)) {
      console.log("🛑 [4] Greeting/noise detected, stopping flow");
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[detectedLang]
      });
    }

    /* ================= 5. LANGUAGE LOCK ================= */
    if (!session.language) {
      console.log("🌐 [5] Locking language:", detectedLang);
      await updateSession({ language: detectedLang });
      session.language = detectedLang;
    }

    const lang = session.language as "en" | "ms" | "zh" | "ta";
    console.log("🌐 [5] Active language:", lang);

    /* ================= 6. INTENT DETECTION ================= */
    console.log("🧠 [6] Intent detection");
    let intent_category: "unit" | "common_area" | "mixed" | "uncertain" =
      "uncertain";
    let intent_source: "keyword" | "ai" | "none" = "none";
    let intent_confidence = 1;

    const t = description_clean.toLowerCase();

    const commonHit = keywordMatch(t, COMMON_AREA_KEYWORDS);
    const unitHit = keywordMatch(t, OWN_UNIT_KEYWORDS);
    const ambiguousHit = keywordMatch(t, AMBIGUOUS_KEYWORDS);

    console.log("🧠 [6] commonHit:", commonHit);
    console.log("🧠 [6] unitHit:", unitHit);
    console.log("🧠 [6] ambiguousHit:", ambiguousHit);

    if (unitHit && commonHit) {
      intent_category = "mixed";
      intent_source = "keyword";
    } else if (unitHit) {
      intent_category = "unit";
      intent_source = "keyword";
    } else if (commonHit) {
      intent_category = "common_area";
      intent_source = "keyword";
    } else if (ambiguousHit) {
      intent_category = "unit";
      intent_source = "keyword";
    } else {
      const ai = await aiClassify(description_clean);
      console.log("🧠 [6] AI result:", ai);
      if (ai.confidence >= 0.7) {
        intent_category = ai.category;
        intent_confidence = ai.confidence;
        intent_source = "ai";
      }
    }

    console.log("🧠 [6] intent_category:", intent_category);

    /* ================= 7. CLARIFY → CONFIRM ================= */
    if (session.state === "idle") {
      console.log("✍️ [7] Entering confirm state");
      await updateSession({
        state: "confirm",
        draft_description: description_clean
      });

      return res.status(200).json({
        reply:
          lang === "ms"
            ? `Saya faham masalah berikut:\n\n"${description_clean}"\n\nBalas:\n1️⃣ Sahkan\n2️⃣ Edit`
            : lang === "zh"
            ? `我理解的问题如下：\n\n"${description_clean}"\n\n回复：\n1️⃣ 确认\n2️⃣ 编辑`
            : lang === "ta"
            ? `நான் புரிந்துகொண்ட பிரச்சனை:\n\n"${description_clean}"\n\nபதில்:\n1️⃣ உறுதி\n2️⃣ திருத்த`
            : `I understood the issue as:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
      });
    }

    /* ================= 8. EDIT FLOW ================= */
    if (session.state === "confirm" && description_raw === "2") {
      console.log("✏️ [8] User chose EDIT");
      await updateSession({ state: "editing" });

      return res.status(200).json({
        reply:
          lang === "ms"
            ? "Baik 👍 Sila taip semula masalah anda."
            : lang === "zh"
            ? "好的 👍 请重新输入您的问题。"
            : lang === "ta"
            ? "சரி 👍 உங்கள் பிரச்சனையை மீண்டும் எழுதுங்கள்."
            : "Okay 👍 Please retype your issue."
      });
    }

    if (session.state === "editing") {
      console.log("✏️ [8.1] Updating draft");
      await updateSession({
        state: "confirm",
        draft_description: description_clean
      });

      return res.status(200).json({
        reply:
          lang === "ms"
            ? `Kemaskini draf:\n\n"${description_clean}"\n\nBalas:\n1️⃣ Sahkan\n2️⃣ Edit`
            : lang === "zh"
            ? `已更新草稿：\n\n"${description_clean}"\n\n回复：\n1️⃣ 确认\n2️⃣ 编辑`
            : lang === "ta"
            ? `வரைவு புதுப்பிக்கப்பட்டது:\n\n"${description_clean}"\n\nபதில்:\n1️⃣ உறுதி\n2️⃣ திருத்த`
            : `Updated draft:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
      });
    }

    /* ================= 9. EXECUTE (CONFIRM ONLY) ================= */
    console.log("🚨 [9] Execution gate reached");
    console.log("🚨 [9] session.state:", session.state);
    console.log("🚨 [9] description_raw:", description_raw);

    if (session.state !== "confirm" || description_raw !== "1") {
      console.log("⛔ [9] Execution blocked");
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[lang]
      });
    }

    console.log("✅ [9] Creating ticket");

    const { data: ticket, error } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: intent_category === "unit" ? unit_id : null,
        description_raw: session.draft_description,
        description_clean: session.draft_description,
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

    if (error || !ticket) {
      console.log("❌ [9] Ticket creation failed", error);
      throw error;
    }

    console.log("🧬 [9] Generating embedding");

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: session.draft_description
    });

    await supabase
      .from("tickets")
      .update({ embedding: emb.data[0].embedding })
      .eq("id", ticket.id);

    console.log("🔍 [9] Duplicate detection");

    await updateSession({
      state: "done",
      current_ticket_id: ticket.id,
      draft_description: null
    });

    console.log("✅ [9] Ticket completed:", ticket.id);

    return res.status(200).json({
      reply: AUTO_REPLIES.ticketCreated[lang],
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
