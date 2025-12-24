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
    zh: "✅ 您的问题已记录。承包商将很快被分配。",
    ta: "✅ உங்கள் புகார் பதிவு செய்யப்பட்டது. விரைவில் தொழிலாளி நியமிக்கப்படுவார்."
  },
  duplicateNotice: {
    en: "⚠️ A similar issue was reported earlier. We’ve linked your report.",
    ms: "⚠️ Isu serupa telah dilaporkan sebelum ini. Aduan anda telah dikaitkan.",
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
          state: "idle",
          language: detectedLang
        })
        .select()
        .single();
      session = data;
    }

    if (!session.language) {
      await supabase
        .from("conversation_sessions")
        .update({ language: detectedLang })
        .eq("id", session.id);
      session.language = detectedLang;
    }

    const lang = session.language as "en" | "ms" | "zh" | "ta";

    /* ================= GREETING ================= */
    if (isGreetingOnly(description_raw)) {
      return res.status(200).json({
        reply: AUTO_REPLIES.greeting[lang]
      });
    }

    /* ================= CREATE TICKET ================= */
    const { data: ticket, error } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        source: "whatsapp",
        status: "new"
      })
      .select()
      .single();

    if (error || !ticket) throw error;

    /* ================= EMBEDDING ================= */
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

      /* ================= DUPLICATE CHECK ================= */
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

    await supabase
      .from("conversation_sessions")
      .update({
        state: "ticket_created",
        current_ticket_id: ticket.id,
        updated_at: new Date().toISOString()
      })
      .eq("id", session.id);

    return res.status(200).json({
      reply: duplicate_of
        ? AUTO_REPLIES.duplicateNotice[lang]
        : AUTO_REPLIES.ticketCreated[lang],
      ticket_id: ticket.id,
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
