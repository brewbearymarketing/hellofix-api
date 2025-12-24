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

function keywordMatch(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/* ================= LANGUAGE DETECTOR ================= */
function detectLanguage(text: string): "en" | "ms" | "zh" | "ta" {
  if (!text) return "en";
  if (/[一-龥]/.test(text)) return "zh";
  if (/[அ-ஹ]/.test(text)) return "ta";

  const t = text.toLowerCase();
  if (
    t === "hai" ||
    t === "salam" ||
    t.includes("tak") ||
    t.includes("nak") ||
    t.includes("rosak") ||
    t.includes("bocor") ||
    t.includes("tolong")
  ) return "ms";

  return "en";
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

/* ================= MEANINGFUL MESSAGE CHECK ================= */
function isMeaningfulMessage(text: string): boolean {
  if (!text) return false;
  if (isGreetingOnly(text)) return false;
  return text.trim().length >= 5;
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
    const detectedLang = detectLanguage(description_raw);

    if (!condo_id || !phone_number) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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

    /* ================= GREETING (NO LANGUAGE LOCK) ================= */
    if (isGreetingOnly(description_raw)) {
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[detectedLang]
      });
    }

    /* ================= LOCK LANGUAGE AFTER GREETING ================= */
    
// ✅ Persist language ONLY on first meaningful message
if (
  isMeaningfulMessage(description_raw) &&
  (!session.language || session.language === "en")
) {
  await supabase
    .from("conversation_sessions")
    .update({ language: detectedLang })
    .eq("id", session.id);

  session.language = detectedLang;
}

// ✅ Always prefer persisted language AFTER update
const lang =
  (session.language as "en" | "ms" | "zh" | "ta") || detectedLang;


    /* ================= CREATE TICKET ================= */
    const { data: ticket } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        source: "whatsapp",
        status: "new"
      })
      .select()
      .single();

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
