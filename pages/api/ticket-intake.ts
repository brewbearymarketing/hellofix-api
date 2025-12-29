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

/* ================= HELPERS (MOVED OUTSIDE HANDLER) ================= */
/* ================= GREETING DETECTOR ================= */
/* ================= WHATSAPP NOISE STRIPPER (NEW, REQUIRED) ================= */
function stripWhatsAppNoise(text: string): string {
  return text

    .replace(/[0-9️⃣•\-–—]/g, " ")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

/* ================= GREETING GUARD ================= */
function isGreetingOnly(text: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase().trim();
  return ["hi","hello","hey","hai","yo","salam","test","ping"].includes(t);
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

/* ================= DISPLAY TRANSLATION (RESIDENT UX) ================= */
async function translateForResident(
  englishText: string,
  lang: Lang
): Promise<string> {
  if (!openai) return englishText;
  if (lang === "en") return englishText;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
Translate the maintenance sentence into the user's language.

Rules:
- Keep meaning EXACT.
- Do NOT add details.
- Do NOT remove details.
- Short, natural, human.
- No emojis.
- Output ONLY the translated sentence.
          `
        },
        {
          role: "user",
          content: \`Language: \${lang}\nText: \${englishText}\`
        }
      ]
    });

    return r.choices[0]?.message?.content?.trim() || englishText;
  } catch {
    return englishText;
  }
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

/* ================= CLEANER ================= */
function cleanTranscript(text: string): string {
  if (!text) return text;
  let t = text.toLowerCase();
  t = t.replace(/\b(uh|um|ah|eh|lah|lor)\b/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
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

/* ================= API HANDLER (HANDLE ALL LOGIC LIKE WAITER IN RESTAURANT)================= */
/* ================= API HANDLER ================= */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const log = (step: string, data?: any) =>
    console.log(`[${new Date().toISOString()}] ${step}`, data ?? "");

  log("REQUEST_START");

  if (req.method !== "POST") {
    log("NON_POST");
    return res.status(200).json({ ok: true });
  }

  try {
    /* 0. PARSE */
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { condo_id, phone_number } = body;
    log("PARSED_BODY", { condo_id, phone_number });

    if (!condo_id || !phone_number) {
      log("MISSING_FIELDS");
      return res.status(400).json({ error: "Missing required fields" });
    }

    /* 1. NORMALIZE */
    const description_raw = await normalizeIncomingMessage(body);
    const description_clean = await aiCleanDescription(description_raw);
    log("TEXT", { description_raw, description_clean });

    const detectedLang = detectLanguage(description_raw);
    log("LANG_DETECTED", detectedLang);

    /* 2. SESSION */
    let { data: session } = await supabase
      .from("conversation_sessions")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!session) {
      log("SESSION_CREATE");
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

    if (!session) throw new Error("Session invalid");
    log("SESSION_STATE", session.state);

    const updateSession = async (fields: any) => {
      log("SESSION_UPDATE", fields);
      await supabase
        .from("conversation_sessions")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("id", session.id);
    };

    /* 3. RESIDENT */
    const { data: resident } = await supabase
      .from("residents")
      .select("unit_id, approved")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (!resident?.approved) {
      log("RESIDENT_BLOCKED");
      return res.status(403).json({ error: "Not approved" });
    }

    /* 4. GREETING BLOCK (CLEAN TEXT ONLY) */
    if (
      session.state === "idle" &&
      !hasProblemSignal(description_clean.toLowerCase())
    ) {
      log("GREETING_BLOCK");
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[detectedLang]
      });
    }

    /* 5. CONFIRM */
    if (session.state === "idle") {
      await updateSession({
        state: "confirm",
        draft_description: description_clean
      });

      log("ASK_CONFIRM");
      return res.status(200).json({
        reply: `I understood the issue as:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
      });
    }

    /* 6. EDIT */
    if (session.state === "confirm" && description_raw === "2") {
      await updateSession({ state: "editing" });
      log("EDIT_REQUESTED");
      return res.status(200).json({
        reply: "Okay 👍 Please retype your issue."
      });
    }

    if (session.state === "editing") {
      await updateSession({
        state: "confirm",
        draft_description: description_clean
      });
      log("EDIT_UPDATED");
      return res.status(200).json({
        reply: `Updated:\n\n"${description_clean}"\n\nReply:\n1️⃣ Confirm\n2️⃣ Edit`
      });
    }

    /* 7. EXECUTE */
    if (session.state !== "confirm" || description_raw !== "1") {
      log("EXECUTION_BLOCKED", {
        state: session.state,
        input: description_raw
      });
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[detectedLang]
      });
    }

    log("TICKET_CREATE");

    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: resident.unit_id,
        description_raw: session.draft_description,
        description_clean: session.draft_description,
        source: "whatsapp",
        status: "new"
      })
      .select()
      .single();

    /* 8. EMBEDDING */
    const emb = await openai!.embeddings.create({
      model: "text-embedding-3-small",
      input: session.draft_description
    });

    await supabase
      .from("tickets")
      .update({ embedding: emb.data[0].embedding })
      .eq("id", ticket.id);

    await updateSession({
      state: "done",
      current_ticket_id: ticket.id,
      draft_description: null
    });

    log("DONE", ticket.id);

    return res.status(200).json({
      reply: AUTO_REPLIES.ticketCreated[detectedLang],
      ticket_id: ticket.id
    });
  } catch (err: any) {
    console.error("FATAL", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}


    
