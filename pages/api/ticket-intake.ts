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

/* ================= LANGUAGE DETECTOR (NEW) ================= */
function detectLanguage(text: string): "en" | "ms" | "zh" | "ta" {
  if (!text) return "en";
  if (/[一-龥]/.test(text)) return "zh";     // Chinese
  if (/[அ-ஹ]/.test(text)) return "ta";     // Tamil

  const t = text.toLowerCase();
  if (
    t.includes("tak") ||
    t.includes("nak") ||
    t.includes("rosak") ||
    t.includes("bocor") ||
    t.includes("boleh")
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
  continuePrompt: {
    en: "You recently reported an issue. Reply:\n1️⃣ Continue previous issue\n2️⃣ Start a new issue",
    ms: "Anda baru melaporkan masalah. Balas:\n1️⃣ Teruskan isu sebelum ini\n2️⃣ Lapor isu baharu",
    zh: "您最近已提交问题。回复：\n1️⃣ 继续之前的问题\n2️⃣ 提交新问题",
    ta: "நீங்கள் சமீபத்தில் ஒரு பிரச்சினையை பதிவு செய்தீர்கள். பதிலளிக்கவும்:\n1️⃣ முந்தையதை தொடர\n2️⃣ புதிய பிரச்சினை"
  },
  continueOk: {
    en: "Okay 👍 Please continue describing the issue.",
    ms: "Baik 👍 Sila teruskan penerangan masalah.",
    zh: "好的 👍 请继续描述问题。",
    ta: "சரி 👍 பிரச்சினையை தொடரவும்."
  },
  newIssue: {
    en: "Alright 👍 Please describe the new issue.",
    ms: "Baik 👍 Sila terangkan isu baharu.",
    zh: "好的 👍 请描述新问题。",
    ta: "சரி 👍 புதிய பிரச்சினையை விவரிக்கவும்."
  },
  multiIssue: {
    en: "I detected multiple issues. Reply:\n1️⃣ Same unit & same contractor\n2️⃣ Separate issues",
    ms: "Saya mengesan beberapa masalah. Balas:\n1️⃣ Unit & kontraktor sama\n2️⃣ Masalah berasingan",
    zh: "检测到多个问题。回复：\n1️⃣ 同一单位和承包商\n2️⃣ 分开处理",
    ta: "பல பிரச்சினைகள் கண்டறியப்பட்டன. பதிலளிக்கவும்:\n1️⃣ அதே யூனிட்\n2️⃣ தனித்தனி பிரச்சினைகள்"
  }
};

/* ================= GREETING GUARD ================= */
function isGreetingOnly(text: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase().trim();
  return (
    ["hi", "hello", "hey", "hai", "yo", "test", "ping", "ok", "okay"].includes(t) ||
    t.length < 5
  );
}

/* ================= NEW ISSUE GUARD ================= */
function isNewIssueIntent(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "new issue",
    "another issue",
    "different issue",
    "also got problem",
    "report another",
    "nak report lain",
    "isu lain"
  ].some(k => t.includes(k));
}

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
  "厕所","空调","கழிப்பிடம்","灯"
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

/* ================= CLEANERS ================= */
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

/* ================= MESSAGE NORMALIZER ================= */
async function normalizeIncomingMessage(body: any): Promise<string> {
  let text: string = body.description_raw || "";

  if (!text && body.voice_url) {
    const transcript = await transcribeVoice(body.voice_url);
    if (transcript) text = transcript;
  }

  if (!text && body.image_url) {
    text = "Photo evidence provided. Issue description pending.";
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
    const lang = detectLanguage(description_raw);

    if (!condo_id || !phone_number) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    /* ================= SESSION LOAD / EXPIRE ================= */
    const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

    let { data: session } = await supabase
      .from("conversation_sessions")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (session) {
      const expired =
        Date.now() - new Date(session.updated_at).getTime() >
        SESSION_TIMEOUT_MS;

      if (expired) {
        await supabase
          .from("conversation_sessions")
          .update({
            state: "idle",
            current_ticket_id: null,
            updated_at: new Date().toISOString()
          })
          .eq("id", session.id);

        session.state = "idle";
        session.current_ticket_id = null;
      }
    }

    if (!session) {
      const { data } = await supabase
        .from("conversation_sessions")
        .insert({ condo_id, phone_number, state: "idle" })
        .select()
        .single();
      session = data;
    }

    /* ================= CONTINUE / NEW ISSUE ================= */
    if (session.state === "closed") {
      if (description_raw === "1") {
        await supabase.from("conversation_sessions").update({ state: "collecting" }).eq("id", session.id);
        return res.status(200).json({ reply: AUTO_REPLIES.continueOk[lang] });
      }

      if (description_raw === "2" || isNewIssueIntent(description_raw)) {
        await supabase.from("conversation_sessions").update({ state: "idle", current_ticket_id: null }).eq("id", session.id);
        return res.status(200).json({ reply: AUTO_REPLIES.newIssue[lang] });
      }

      return res.status(200).json({ reply: AUTO_REPLIES.continuePrompt[lang] });
    }

    /* ================= GREETING ================= */
    if (isGreetingOnly(description_raw)) {
      return res.status(200).json({ reply: AUTO_REPLIES.greeting[lang] });
    }

    /* ================= MULTI ISSUE ================= */
    if (description_raw.includes(" and ") || description_raw.includes(",")) {
      await supabase.from("conversation_sessions").update({ state: "confirming_split" }).eq("id", session.id);
      return res.status(200).json({ reply: AUTO_REPLIES.multiIssue[lang] });
    }

    return res.status(200).json({ ok: true });

  } catch (err: any) {
    console.error("🔥 ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
