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

console.log("OPENAI ENABLED:", !!openai);

/* ================= HELPER/REUSABLE FUNCTION ALL BELOW THIS ================= */
/* ================= ABUSE / SPAM THROTTLING ================= */
const THROTTLE_WINDOW_SECONDS = 60;
const THROTTLE_SOFT_LIMIT = 5;
const THROTTLE_HARD_LIMIT = 8;
const THROTTLE_BLOCK_MINUTES = 5;

async function checkThrottle(
  condo_id: string,
  phone_number: string
): Promise<{
  allowed: boolean;
  level: "ok" | "soft" | "blocked";
  count: number;
}> {
  const now = new Date();

  const { data, error } = await supabase
    .from("message_throttle")
    .select("*")
    .eq("condo_id", condo_id)
    .eq("phone_number", phone_number)
    .maybeSingle();

  // Fail open
  if (error) {
    return { allowed: true, level: "ok", count: 1 };
  }

  // First message
  if (!data) {
    await supabase.from("message_throttle").insert({
      condo_id,
      phone_number,
      message_count: 1,
      first_seen_at: now
    });

    return { allowed: true, level: "ok", count: 1 };
  }

  // Hard blocked
  if (data.blocked_until && new Date(data.blocked_until) > now) {
    return {
      allowed: false,
      level: "blocked",
      count: data.message_count
    };
  }

  const windowStart = new Date(data.first_seen_at);
  const diffSeconds = (now.getTime() - windowStart.getTime()) / 1000;

  // Window expired → reset
  if (diffSeconds > THROTTLE_WINDOW_SECONDS) {
    await supabase
      .from("message_throttle")
      .update({
        message_count: 1,
        first_seen_at: now,
        blocked_until: null,
        updated_at: now
      })
      .eq("id", data.id);

    return { allowed: true, level: "ok", count: 1 };
  }

  const newCount = data.message_count + 1;

  // Hard limit
  if (newCount > THROTTLE_HARD_LIMIT) {
    const blockedUntil = new Date(
      now.getTime() + THROTTLE_BLOCK_MINUTES * 60 * 1000
    );

    await supabase
      .from("message_throttle")
      .update({
        message_count: newCount,
        blocked_until: blockedUntil,
        updated_at: now
      })
      .eq("id", data.id);

    return {
      allowed: false,
      level: "blocked",
      count: newCount
    };
  }

  // Soft / normal
  await supabase
    .from("message_throttle")
    .update({
      message_count: newCount,
      updated_at: now
    })
    .eq("id", data.id);

  return {
    allowed: true,
    level: newCount > THROTTLE_SOFT_LIMIT ? "soft" : "ok",
    count: newCount
  };
}

/* ================= THROTTLE NOTICE ================= */
function buildThrottleNotice(
  lang: "en" | "ms" | "zh" | "ta"
): string {
  switch (lang) {
    case "ms":
      return "Anda menghantar mesej terlalu cepat. Sila tunggu sebentar sebelum menghantar mesej seterusnya.";
    case "zh":
      return "您发送消息过于频繁。请稍等片刻后再发送。";
    case "ta":
      return "நீங்கள் மிக விரைவாக செய்திகளை அனுப்புகிறீர்கள். தயவுசெய்து சிறிது நேரம் காத்திருந்து மீண்டும் அனுப்பவும்.";
    default:
      return "You are sending messages too quickly. Please wait a moment before sending another message.";
  }
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
  "厕所","空调","கழிப்பிடம்","चिराग","灯"
];

/* ===== GREETING GUARD 1/ NO-INTENT KEYWORDS ===== */
const GREETING_KEYWORDS = [
  "hi","hello","hey","morning","afternoon","evening",
  "good morning","good afternoon","good evening",
  "thanks","thank you","tq","ok","okay","noted",
  "test","testing","yo","boss","bro","sis",

  // Malay
  "hai","helo","selamat pagi","selamat petang","selamat malam",
  "terima kasih","okey",

  // Chinese
  "你好","早安","晚安","谢谢",

  // Tamil
  "வணக்கம்","நன்றி"
];

function keywordMatch(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/* ===== GREETING GUARD 2 ===== */
function isGreetingOnly(text: string): boolean {
  const t = text.toLowerCase().trim();

  // Very short messages are almost always noise
  if (t.length <= 6) return true;

  // Pure greeting
  return GREETING_KEYWORDS.some(
    k => t === k || t.startsWith(k + " ")
  );
}

/* ===== GREETING GUARD 3/ AI MEANINGFUL ISSUE CHECK (BANK-GRADE) ===== */
async function aiIsMeaningfulIssue(text: string): Promise<boolean> {
  if (!openai) return true; // fail-open

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Reply ONLY JSON: {\"is_issue\": true|false}. " +
            "True ONLY if message describes a real property maintenance problem."
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const raw = r.choices[0]?.message?.content;
    const obj = typeof raw === "string" ? JSON.parse(raw) : {};
    return obj.is_issue === true;
  } catch {
    return true;
  }
}

/* ================= DETECT LANGUAGE ================= */
function detectLanguage(text: string): "en" | "ms" | "zh" | "ta" {
  const t = text.toLowerCase();

  if (/[\u4e00-\u9fff]/.test(t)) return "zh"; // Chinese
  if (/[\u0b80-\u0bff]/.test(t)) return "ta"; // Tamil

  if (
    t.includes("hai") ||
    t.includes("selamat") ||
    t.includes("terima kasih")
  ) return "ms";

  return "en";
}

/* ================= AI LANGUAGE DETECTOR ================= */
async function aiDetectLanguage(
  text: string
): Promise<"en" | "ms" | "zh" | "ta"> {
  if (!openai) return "en";

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Detect the primary language of the message. " +
            "Reply ONLY JSON: {\"lang\": \"en\"|\"ms\"|\"zh\"|\"ta\"}. " +
            "Malay = ms. Ignore greetings."
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const raw = r.choices[0]?.message?.content;
    const obj = typeof raw === "string" ? JSON.parse(raw) : {};

    if (["en", "ms", "zh", "ta"].includes(obj.lang)) {
      return obj.lang;
    }

    return "en";
  } catch {
    return "en";
  }
}


/* ================= BANK GRADE REPLY GENERATOR ================= */
function buildReplyText(
  lang: "en" | "ms" | "zh" | "ta",
  type: "greeting" | "confirmed",
  ticketId?: string
): string {
  if (type === "greeting") {
    switch (lang) {
      case "zh":
        return "您好！请简单描述需要报修的问题，例如：电梯故障、厨房水管漏水。谢谢。";
      case "ta":
        return "வணக்கம்! பராமரிப்பு பிரச்சனையை தெளிவாக விவரிக்கவும் (உதா: லிப்ட் வேலை செய்யவில்லை, குழாய் கசிவு). நன்றி.";
      case "ms":
        return "Hai! Sila terangkan masalah penyelenggaraan dengan ringkas (contoh: paip bocor, lif rosak). Terima kasih.";
      default:
        return "Hello! Please briefly describe the maintenance issue (e.g. leaking pipe, lift not working). Thank you.";
    }
  }

  // confirmed
  switch (lang) {
    case "zh":
      return `感谢您的反馈。维修工单已创建。\n工单编号: ${ticketId}`;
    case "ta":
      return `உங்கள் புகார் பதிவு செய்யப்பட்டது.\nடிக்கெட் எண்: ${ticketId}`;
    case "ms":
      return `Terima kasih. Laporan penyelenggaraan telah diterima.\nNo Tiket: ${ticketId}`;
    default:
      return `Thank you. Your maintenance report has been received.\nTicket ID: ${ticketId}`;
  }
}

/* ================= BUILD DRAFT MENU ================= */
function buildDraftMenu(
  lang: "en" | "ms" | "zh" | "ta",
  summary: string
) {
  return `Please confirm your maintenance request:\n"${summary}"\n\n1️⃣ Submit\n2️⃣ Edit\n3️⃣ Cancel`;
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

/* ================= TRANSCRIPT CLEANER ================= */
function cleanTranscript(text: string): string {
  if (!text) return text;

  let t = text.toLowerCase();

  t = t.replace(
    /\b(uh|um|erm|err|ah|eh|lah|lor|meh|macam|seperti|kinda|sort of)\b/g,
    ""
  );

  t = t.replace(/\b(\w+)(\s+\1\b)+/g, "$1");
  t = t.replace(/\s+/g, " ").trim();

  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ================= VOICE TRANSCRIPTION ================= */
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

    const file = await toFile(
      Buffer.from(buffer),
      "voice",
      { type: res.headers.get("content-type") || "application/octet-stream" }
    );

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

/* ================= NORMALIZE INPUT ================= */
    const body =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { condo_id, phone_number } = body;

    const description_raw = await normalizeIncomingMessage(body);

    if (!condo_id || !phone_number || !description_raw) {
      return res.status(400).json({ error: "Missing required fields" });
    }

  /* ===== DETECT NUMERIC REPLY ===== */
    const numericReply = description_raw.trim();

    const isConfirm = numericReply === "1";
    const isEdit = numericReply === "2";
    const isCancel = numericReply === "3";

    /* ===== LANGUAGE IS NULL UNTIL MEANINGFUL ===== */
    let lang: "en" | "ms" | "zh" | "ta" | null = null;

  /* ==============🔒 CHECK EXISTING CONVERSATION LANGUAGE===== */
    const { data: existingTicket } = await supabase
      .from("tickets")
      .select("id, language")
      .eq("condo_id", condo_id)
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingTicket?.language) {
      lang = existingTicket.language;
    }


  /* ============ 🔒 CHECK EXISTING DRAFT LANGUAGE ============ */
    const { data: existingDraft } = await supabase
      .from("ticket_drafts")
      .select("*")
      .eq("condo_id", condo_id)
      .eq("phone_number", phone_number)
      .maybeSingle();

    if (existingDraft?.language) {
    lang = existingDraft.language;
    }

    /* ===== ABUSE / SPAM THROTTLING (ALWAYS FIRST) ===== */
    const throttle = await checkThrottle(condo_id, phone_number);

    if (!throttle.allowed) {
    const tempLang = lang ?? detectLanguage(description_raw);
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildThrottleNotice(tempLang)
    });
  }


    if (throttle.level === "soft") {
      const meaningful = await aiIsMeaningfulIssue(description_raw);
      if (!meaningful) {
        const tempLang = lang ?? detectLanguage(description_raw);
        return res.status(200).json({
          success: true,
          ignored: true,
          reply_text: buildReplyText(tempLang, "greeting")
        });
      }
    }

    /* ===== GREETING SHORT-CIRCUIT (ONCE PER WINDOW) ===== */
    if (isGreetingOnly(description_raw)) {
  const tempLang = lang ?? detectLanguage(description_raw);

  // First message only → greeting
  if (throttle.count === 1) {
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildReplyText(tempLang, "greeting")
    });
  }

  // Second message → explicit throttle warning
  if (throttle.count === 2) {
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildThrottleNotice(tempLang)
    });
  }

  // After that → silent
  return res.status(200).json({
    success: true,
    ignored: true
  });
}
       /* ===== MEANINGFUL INTENT CHECK ===== */
  const hasMeaningfulIntent = await aiIsMeaningfulIssue(description_raw);

  if (!hasMeaningfulIntent) {
    const tempLang = lang ?? detectLanguage(description_raw);
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildReplyText(tempLang, "greeting")
    });
  }

    /* ===== 🔒 LOCK LANGUAGE ONLY ONCE (AI CONFIRMED) & CLEAN ISSUE ===== */
let description_clean = existingDraft?.description_clean ?? null;

if (!existingDraft) {
  if (!lang) {
    lang = await aiDetectLanguage(description_raw);
  }
  description_clean = await aiCleanDescription(description_raw);
}

   /* ===== NUMERIC DRAFT ACTION ===== */

  if (existingDraft && isConfirm) {
  // resident verification (UNCHANGED)

     /* ===== SKIP AI CLEANING FOR NUMERIC REPLIES ===== */
if (!existingDraft) {
  description_clean = await aiCleanDescription(description_raw);
}
    
  const unit_id = resident.unit_id;

  const { data: ticket } = await supabase
    .from("tickets")
    .insert({
      condo_id,
      unit_id: existingDraft.intent_category === "unit" ? unit_id : null,
      description_raw: existingDraft.description_raw,
      description_clean: existingDraft.description_clean,
      source: "whatsapp",
      status: "new",
      is_common_area: existingDraft.intent_category === "common_area",
      intent_category: existingDraft.intent_category,
      intent_source: existingDraft.intent_source,
      intent_confidence: existingDraft.intent_confidence,
      diagnosis_fee:
        existingDraft.intent_category === "unit" ? 30 : 0,
      language: existingDraft.language
    })
    .select()
    .single();

    
    /* ===== EMBEDDING + DUPLICATE ===== */
    if (openai && description_clean) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description_clean
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
          ticket_unit_id: ticket.unit_id,
          ticket_is_common_area: ticket.is_common_area,
          exclude_id: ticket.id,
          similarity_threshold: 0.85
        }
      );

      if (relation?.length) {
        const r = relation[0];

        await supabase
          .from("tickets")
          .update({
            is_duplicate: r.relation_type === "hard_duplicate",
            duplicate_of:
              r.relation_type === "hard_duplicate"
                ? r.related_ticket_id
                : null,
            related_to:
              r.relation_type === "related"
                ? r.related_ticket_id
                : null
          })
          .eq("id", ticket.id);
      }
    }    
    
  const { data: resident } = await supabase
    .from("residents")
    .select("unit_id, approved")
    .eq("condo_id", condo_id)
    .eq("phone_number", phone_number)
    .maybeSingle();

  if (!resident || !resident.approved) {
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text:
        "⚠️ Your phone number is not registered. Please contact management."
    });
  }

  await supabase
    .from("ticket_drafts")
    .delete()
    .eq("id", existingDraft.id);

  return res.status(200).json({
    success: true,
    ticket_id: ticket.id,
    reply_text: buildReplyText(existingDraft.language, "confirmed", ticket.id)
  });
}

  if (existingDraft && isEdit) {
  return res.status(200).json({
    success: true,
    ignored: true,
    reply_text: "Please re-enter the maintenance issue description."
  });
}

  if (existingDraft && isCancel) {
  await supabase
    .from("ticket_drafts")
    .delete()
    .eq("id", existingDraft.id);

  return res.status(200).json({
    success: true,
    ignored: true,
    reply_text: "Request cancelled."
  });
}

    /* ===== INTENT DETECTION ===== */
    let intent_category: "unit" | "common_area" | "mixed" | "uncertain" =
      "uncertain";
    let intent_source: "keyword" | "ai" | "none" = "none";
    let intent_confidence = 1;

    const commonHit = keywordMatch(description_raw, COMMON_AREA_KEYWORDS);
    const unitHit = keywordMatch(description_raw, OWN_UNIT_KEYWORDS);
    const ambiguousHit = keywordMatch(description_raw, AMBIGUOUS_KEYWORDS);

    if (commonHit && unitHit) {
      intent_category = "mixed";
      intent_source = "keyword";
    } else if (commonHit && !ambiguousHit) {
      intent_category = "common_area";
      intent_source = "keyword";
    } else if (unitHit && !ambiguousHit) {
      intent_category = "unit";
      intent_source = "keyword";
    } else {
      const ai = await aiClassify(description_raw);
      if (ai.confidence >= 0.7) {
        intent_category = ai.category;
        intent_confidence = ai.confidence;
        intent_source = "ai";
      }
    }

  /* ===== CREATE OR UPDATE DRAFT ===== */
if (!existingDraft) {
  await supabase.from("ticket_drafts").insert({
    condo_id,
    phone_number,
    description_raw,
    description_clean,
    intent_category,
    intent_source,
    intent_confidence,
    language: lang
  });
} else {
  await supabase
    .from("ticket_drafts")
    .update({
      description_raw,
      description_clean,
      intent_category,
      intent_source,
      intent_confidence,
      updated_at: new Date()
    })
    .eq("id", existingDraft.id);
}

   /* ===== ASK FOR NUMERIC CONFIRMATION ===== */
  return res.status(200).json({
  success: true,
  draft: true,
  reply_text: buildDraftMenu(lang, description_clean)
});

  } catch (err: any) {
    console.error("🔥 ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}
