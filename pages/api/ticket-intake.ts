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

/* ================= LANGUAGE DETECTOR ================= */
function detectLanguage(text: string): "en" | "ms" | "zh" | "ta" {
  if (!text) return "en";

  // Chinese
  if (/[一-龥]/.test(text)) return "zh";

  // Tamil
  if (/[அ-ஹ]/.test(text)) return "ta";

  const t = text.toLowerCase().trim();

  // Malay (include greetings)
  if (
    t === "hai" ||
    t === "salam" ||
    t.includes("tolong") ||
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
  }
};

/* ================= GREETING GUARD ================= */
function isGreetingOnly(text: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase().trim();
  return (
    ["hi", "hello", "hey", "hai", "yo", "test", "ping", "ok", "okay", "salam"].includes(t) ||
    t.length < 5
  );
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

/* ================= MESSAGE NORMALIZER ================= */
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

    /* ================= SESSION LOAD / CREATE ================= */
    let { data: session } = await supabase
      .from("conversation_sessions")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    // Create session if not exists
    if (!session) {
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

    // Persist language if not set yet
    if (!session.language) {
      await supabase
        .from("conversation_sessions")
        .update({ language: detectedLang })
        .eq("id", session.id);

      session.language = detectedLang;
    }

    const lang = session.language as "en" | "ms" | "zh" | "ta";

    /* ================= GREETING AUTO-REPLY ================= */
    if (isGreetingOnly(description_raw)) {
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[lang]
      });
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
