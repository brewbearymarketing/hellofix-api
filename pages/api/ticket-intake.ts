import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

/* ================= ⭐CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

console.log("OPENAI ENABLED:", !!openai);

/* ================= ⭐PER PHONE EXECUTIION LOCK ================= */
async function withPhoneLock<T>(
  supabase: any,
  phone: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const { data: locked } = await supabase.rpc(
    "pg_try_advisory_lock",
    { key: phone }
  );

  if (!locked) return null;

  try {
    return await fn();
  } finally {
    await supabase.rpc("pg_advisory_unlock", { key: phone });
  }
}


/*==============================================================================1. 🧠 HANDLERS =================================================================================================*/
/* ================= A. INTAKE HANDLER ================= */
/* =====================================================
   🧠 ROOT HANDLER (ENTRY POINT)
   - NO BUSINESS LOGIC
   - NO STATE ROUTING
   - NO AI
===================================================== */

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(200).end();
  }

  const body =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  const { condo_id } = body;
  const phone_number = normalizeWhatsappPhone(body.phone_number);

  if (!condo_id || !phone_number) {
  return res.status(400).json({ error: "Missing required fields" });
  }

  if (!condo_id || !phone_number) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // 🔒 BANK-GRADE SERIALIZATION (ONE MESSAGE PER PHONE)
   const result = await withPhoneLock(
    supabase,
    phone_number, // already normalized
    async () => {
    return await coreHandler(req, res, {
      ...body,
      phone_number
      });
    }
  );

  // If locked → silently ignore (bank behavior)
  if (result === null) {
    return res.status(200).json({ success: true });
  }

  return result;
}

/* =====================================================
  🧠 CORE HANDLER
   - Fetch session
   - Recover session
   - Decide: intake vs non-intake
   - Route state ONCE
===================================================== */
async function coreHandler(
  req: NextApiRequest,
  res: NextApiResponse,
  body: any
) {
  try{
  const condo_id = body.condo_id;
  const phone_number = body.phone_number; // already normalized

      /* =================🧠 HANDLERS NORMALIZE MESSAGE ================= */
  const description_raw = await normalizeIncomingMessage(body);

  if (!description_raw) {
    return res.status(200).json({ success: true });
  }

    /* ===== 🧠 HANDLERS FETCH SESSION ===== */
  const { data: session } = await supabase
  .from("conversation_sessions")
  .select("id, state, current_ticket_id, language")
  .eq("condo_id", condo_id)
  .eq("phone_number", phone_number)
  .maybeSingle();

    /* ================= 🧠 HANDLERS FETCH LATEST OPEN TICKET ================= */
  const { data: existingTicket } = await supabase
  .from("tickets")
  .select("id, status, language")
  .eq("condo_id", condo_id)
  .in("status", ["new", "confirmed"])
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();


/* ================= 🔴🧠 HANDLERS SESSION AUTO-RECOVERY (MANDATORY) ================= */
let effectiveSession = session;

if (!session && existingTicket) {
  const { data: recoveredSession } = await supabase
    .from("conversation_sessions")
    .upsert({
      condo_id,
      phone_number,
      current_ticket_id: existingTicket.id,
      state: "awaiting_confirmation",
      language: existingTicket.language ?? "en",
      updated_at: new Date()
    })
    .select()
    .single();

  effectiveSession = recoveredSession;
}

const conversationState =
  effectiveSession?.state ?? "intake";
    
/* ================= 🆕 BLOCK NEW TICKET IF EXISTING ACTIVE ================= */
if (
  conversationState === "intake" &&
  effectiveSession?.state &&
  ["draft_edit", "edit_menu", "edit_category", "awaiting_payment"].includes(
    effectiveSession.state
  )
) {
  return res.status(200).json({
    success: true,
    reply_text:
      "⚠️ You already have an ongoing ticket. Please cancel it before creating a new request."
  });
}
  

/* =====================================================
     🔁 SINGLE STATE ROUTE (NON-INTAKE)
     - NO THROTTLE
     - NO AI
     - NO GUESSING
  ===================================================== */

  if (conversationState !== "intake") {
    return routeByState(req, res, effectiveSession);
  }

  /* =====================================================
     ⬇⬇⬇ INTAKE LOGIC (YOUR EXISTING v6 CODE) ⬇⬇⬇

     MOVE YOUR CURRENT INTAKE CODE HERE, UNCHANGED:
     - throttle
     - greeting guards
     - meaningful intent
     - language lock
     - resident verification
     - intent detection
     - ticket creation
     - embedding + duplicate
     - reply_text

     ❗ DO NOT add state routing here
  ===================================================== */
/* ================= ❌HARD MENU GUARD (DO NOT MOVE) ================= */
const menuText = description_raw.trim();
const isMenuReply = ["1", "2", "3"].includes(menuText);

if (isMenuReply && !effectiveSession?.current_ticket_id) {
  return res.status(200).json({
    success: true,
    reply_text:
      "⚠️ Sesi anda telah tamat. Sila hantar semula masalah penyelenggaraan."
  });
}
    
    /* ===== ❌LANGUAGE IS NULL UNTIL MEANINGFUL ===== */
    let lang: "en" | "ms" | "zh" | "ta" | null = null;

  /* ============❌CHECK EXISTING CONVERSATION LANGUAGE================ */

    if (existingTicket?.language) {
      lang = existingTicket.language;
    }

    /* ===== 🧠 ABUSE / SPAM THROTTLING (ALWAYS FIRST) ===== */
    const throttle = await checkThrottle(condo_id, phone_number);

    if (!throttle.allowed) {
    const tempLang = lang ?? detectLanguage(description_raw);
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildThrottleNotice(tempLang)
    });
  }


    if (throttle.level === "soft" && conversationState === "intake") {
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
if (
  !isMenuReply &&
  conversationState === "intake" &&
  !effectiveSession?.current_ticket_id &&
  isGreetingOnly(description_raw)
) {

  const tempLang = lang ?? detectLanguage(description_raw);

  // First message only → greeting
  if (throttle.count === 1) {
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildReplyText(tempLang, "greeting")
    });
  }

  // Second greeting → soft nudge
if (throttle.count === 2) {
  return res.status(200).json({
    success: true,
    ignored: true,
    reply_text: buildReplyText(tempLang, "greeting_soft")
  });
}

// Third+ greeting → firm but polite
if (throttle.count === 3) {
return res.status(200).json({
  success: true,
  ignored: true,
  reply_text: buildReplyText(tempLang, "greeting_firm")
});
}
}
    
   /* ========= 🧠MEANINGFUL INTENT CHECK ============ */
if (conversationState === "intake" && !isMenuReply) {
  const hasMeaningfulIntent = await aiIsMeaningfulIssue(description_raw);

  if (!hasMeaningfulIntent) {
    const tempLang = lang ?? detectLanguage(description_raw);
    return res.status(200).json({
      success: true,
      ignored: true,
      reply_text: buildReplyText(tempLang, "non_maintenance")
    });
  }
  }

    /* ===== 🔴 🧠LOCK LANGUAGE ONLY ONCE (AI CONFIRMED) ===== */
    lang = await aiDetectLanguage(description_raw);

        const description_clean = await aiCleanDescription(description_raw);

const description_display =
  lang === "en"
    ? description_clean
    : await aiTranslateForDisplay(description_clean, lang);


       /* ===== 🧠 VERIFY RESIDENT ===== */
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
        "⚠️Your phone number is not registered. Please contact your management office to register before submitting maintenance requests. ⚠️ Nombor telefon anda belum berdaftar. Sila hubungi management ofis untuk mendaftar sebelum menghantar tiket penyelenggaraan"
});

    }

    const unit_id = resident.unit_id;

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

    /* ===== 🧠 CREATE TICKET ===== */
    const { data: ticket, error } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        unit_id: intent_category === "unit" ? unit_id : null,
        description_raw,
        description_clean,
        source: "whatsapp",
        status: "new",
        is_common_area: intent_category === "common_area",
        intent_category,
        intent_source,
        intent_confidence,
        diagnosis_fee: intent_category === "unit" ? 30 : 0,
        language: lang
      })
      .select()
      .single();

      if (error || !ticket) throw error;
    
/* ===== 🔒 SET CONVERSATION STATE AFTER INTAKE ===== */
      await supabase
      .from("conversation_sessions")
      .upsert({
      condo_id,
      phone_number,
      current_ticket_id: ticket.id,
      state: "awaiting_confirmation",
      language: lang,
      updated_at: new Date()
      });

    /* ===== 🧠 EMBEDDING + DUPLICATE ===== */
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

    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      intent_category,
      reply_text: buildReplyText(
  lang,
  "intake_received",
  undefined,
  description_display,
  intent_category
)
    });
  }

  catch (err: any) {
    console.error("🔥 ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message
    });
  }
}

/* =====================================================
   SINGLE STATE ROUTER (AUTHORITATIVE)
   - ONE switch
   - ONE exit
===================================================== */
async function routeByState(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  switch (session.state) {

    case "awaiting_confirmation":
      return handleConfirmation(req, res, session);

    case "edit_menu":
      return handleEditMenu(req, res, session);

    case "edit_category":
      return handleEditCategory(req, res, session);

    case "draft_edit":
      return handleDraftEdit(req, res, session);

    case "awaiting_payment":
      return handlePayment(req, res, session);

    case "awaiting_category":
      return handleCategorySelection(req, res, session);

    case "awaiting_schedule":
      return handleScheduleSelection(req, res, session);

    case "contractor_assignment":
      return handleContractorAssignment(req, res, session);

    case "closed":
      return res.status(200).json({ success: true });

    default:
      return res.status(200).json({
        success: true,
        reply_text:
          "⚠️ Please send your maintenance issue again."
      });
  }
}

/*=========🧠HANDLER FOR ROUTER=============*/

async function handleConfirmation(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  if (!["1", "2", "3"].includes(text)) {
    return res.status(200).json({
      success: true,
      reply_text: buildFollowUpReply(lang, "invalid_confirm")
    });
  }

  const ticketId = session.current_ticket_id;

  if (text === "1") {
    await supabase
      .from("tickets")
      .update({ status: "confirmed" })
      .eq("id", ticketId);

    await supabase
      .from("conversation_sessions")
      .update({ state: "awaiting_category" }) // 🆕 NEW
      .eq("condo_id", session.condo_id)
      .eq("phone_number", session.phone_number)
      .eq("id", session.id);


    const paymentUrl =
  `https://hellofix-api.vercel.app/api/pay?ticket_id=${ticketId}`;

    return res.status(200).json({
    success: true,
    reply_text:
    buildFollowUpReply(lang, "confirm_success") +
    "\n\n" +
    (lang === "ms"
      ? `💳 Pembayaran diperlukan\nSila buat pembayaran melalui pautan berikut:\n${paymentUrl}\n\nSelepas pembayaran disahkan:\n• Kontraktor akan ditugaskan\n• Anda akan dimaklumkan melalui WhatsApp`
      : lang === "zh"
      ? `💳 需要付款\n请通过以下链接完成付款：\n${paymentUrl}\n\n付款确认后：\n• 将分配承包商\n• 您将收到 WhatsApp 通知`
      : lang === "ta"
      ? `💳 கட்டணம் தேவை\nகீழே உள்ள இணைப்பின் மூலம் பணம் செலுத்தவும்:\n${paymentUrl}\n\nபணம் உறுதி செய்யப்பட்ட பின்:\n• ஒப்பந்ததாரர் நியமிக்கப்படுவார்\n• WhatsApp மூலம் அறிவிக்கப்படும்`
      : `💳 Payment required\nPlease complete payment via the link below:\n${paymentUrl}\n\nAfter payment is confirmed:\n• A contractor will be assigned\n• You will be notified via WhatsApp`)
});
  }

if (text === "2") {
  await supabase
    .from("conversation_sessions")
    .update({ state: "edit_menu" })
    .eq("condo_id", session.condo_id)
    .eq("phone_number", session.phone_number)
    .eq("id", session.id);

  return res.status(200).json({
    success: true,
    reply_text:
      lang === "ms"
        ? "✏️ Apa yang anda ingin edit?\n1️⃣ Edit keterangan\n2️⃣ Edit kategori"
        : lang === "zh"
        ? "✏️ 您要编辑什么？\n1️⃣ 编辑描述\n2️⃣ 编辑类别"
        : lang === "ta"
        ? "✏️ நீங்கள் எதை திருத்த விரும்புகிறீர்கள்?\n1️⃣ விளக்கம்\n2️⃣ வகை"
        : "✏️ What would you like to edit?\n1️⃣ Edit description\n2️⃣ Edit category"
  });
}

if (text === "3") {
  await supabase
    .from("tickets")
    .update({ status: "cancelled" })
    .eq("id", ticketId);

  await supabase
    .from("conversation_sessions")
    .update({
      state: "intake",
      current_ticket_id: null
    })
    .eq("condo_id", session.condo_id)
    .eq("id", session.id)
    .eq("phone_number", session.phone_number);


  return res.status(200).json({
    success: true,
    reply_text: buildFollowUpReply(lang, "cancelled")
  });
}
}

async function handleEditMenu(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  if (text === "1") {
    await supabase
      .from("conversation_sessions")
      .update({ state: "draft_edit" })
      .eq("condo_id", session.condo_id)
      .eq("phone_number", session.phone_number)
      .eq("id", session.id);


    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "✏️ Sila hantar keterangan isu yang baharu."
          : lang === "zh"
          ? "✏️ 请发送新的问题描述。"
          : lang === "ta"
          ? "✏️ தயவுசெய்து புதிய பிரச்சனை விளக்கத்தை அனுப்பவும்."
          : "✏️ Please send the new issue description."
    });
  }

  if (text === "2") {
    await supabase
      .from("conversation_sessions")
      .update({ state: "edit_category" })
      .eq("condo_id", session.condo_id)
      .eq("id", session.id)
      .eq("phone_number", session.phone_number);


    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "🏷️ Pilih kategori:\n1️⃣ Unit\n2️⃣ Kawasan bersama\n3️⃣ Campuran"
          : lang === "zh"
          ? "🏷️ 选择类别：\n1️⃣ 单位\n2️⃣ 公共区域\n3️⃣ 混合"
          : lang === "ta"
          ? "🏷️ வகையைத் தேர்வு செய்யவும்:\n1️⃣ யூனிட்\n2️⃣ பொது பகுதி\n3️⃣ கலப்பு"
          : "🏷️ Select category:\n1️⃣ Unit\n2️⃣ Common area\n3️⃣ Mixed"
    });
  }

  return res.status(200).json({
    success: true,
    reply_text:
      lang === "ms"
        ? "Sila balas dengan 1 atau 2 sahaja."
        : lang === "zh"
        ? "请只回复 1 或 2。"
        : lang === "ta"
        ? "1 அல்லது 2 மட்டும் பதிலளிக்கவும்."
        : "Please reply with 1 or 2 only."
  });
}

async function handleDraftEdit(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const newText = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

if (!newText || newText.length < 10) {
  return res.status(200).json({
    success: true,
    reply_text:
    lang === "ms"
        ? "Sila berikan penerangan isu yang lebih jelas."
        : lang === "zh"
        ? "请提供更清楚的问题描述。"
        : lang === "ta"
        ? "தயவுசெய்து பிரச்சனையை தெளிவாக விவரிக்கவும்."
        : "Please provide a clearer description of the issue."
  });
}

  await supabase
    .from("tickets")
    .update({
    description_raw: newText,
    updated_at: new Date()
  })
  .eq("id", session.current_ticket_id);

  const { data: updatedTicket } = await supabase
  .from("tickets")
  .select("intent_category,description_clean")
  .eq("id", session.current_ticket_id)
  .single();

  const intentLabel = formatIntentLabel(
  updatedTicket?.intent_category ?? "uncertain",
  lang);

  const latestClean = updatedTicket?.description_clean ?? newText;

  const description_display =
  lang === "en"
    ? latestClean
    : await aiTranslateForDisplay(latestClean, lang);
  
  await supabase
    .from("conversation_sessions")
    .update({ state: "awaiting_confirmation" })
    .eq("condo_id", session.condo_id)
    .eq("phone_number", session.phone_number);


return res.status(200).json({
  success: true,
  reply_text:
    lang === "ms"
      ? `✏️ Keterangan telah dikemaskini.

Kami memahami isu anda berkaitan:
"${description_display}"

"Kategori: ${intentLabel}"

Sila balas:
1️⃣ Sahkan tiket
2️⃣ Edit semula
3️⃣ Batalkan tiket`
      : lang === "zh"
      ? `✏️ 描述已更新。

我们理解您的问题是关于：
"${description_display}"

"类别：${intentLabel}"

请回复：
1️⃣ 确认工单
2️⃣ 再次编辑
3️⃣ 取消工单`
      : lang === "ta"
      ? `✏️ விளக்கம் புதுப்பிக்கப்பட்டது.

உங்கள் பிரச்சனை தொடர்புடையது:
"${description_display}"

"வகை: ${intentLabel}"

பதில்:
1️⃣ டிக்கெட்டை உறுதி செய்ய
2️⃣ மீண்டும் திருத்த
3️⃣ டிக்கெட்டை ரத்து செய்ய`
      : `✏️ Description updated.

We understand your issue relates to:
"${description_display}"

"Category: ${intentLabel}"

Please reply:
1️⃣ Confirm ticket
2️⃣ Edit again
3️⃣ Cancel ticket`
});
}

async function handleEditCategory(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  const map: Record<string, "unit" | "common_area" | "mixed"> = {
    "1": "unit",
    "2": "common_area",
    "3": "mixed"
  };

  const selected = map[text];

  if (!selected) {
    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "Sila pilih 1, 2 atau 3."
          : lang === "zh"
          ? "请选择 1、2 或 3。"
          : lang === "ta"
          ? "1, 2 அல்லது 3 தேர்வு செய்யவும்."
          : "Please select 1, 2, or 3."
    });
  }

  await supabase
    .from("tickets")
    .update({
      intent_category: selected,
      intent_source: "user",
      updated_at: new Date()
    })
    .eq("id", session.current_ticket_id);

  await supabase
    .from("conversation_sessions")
    .update({ state: "awaiting_confirmation" })
    .eq("condo_id", session.condo_id)
    .eq("phone_number", session.phone_number);


  const label = formatIntentLabel(selected, lang);

  return res.status(200).json({
    success: true,
    reply_text:
  lang === "ms"
    ? `🏷️ Kategori dikemaskini: ${label}

Sila balas:
1️⃣ Sahkan tiket
2️⃣ Edit semula
3️⃣ Batalkan tiket`
    : lang === "zh"
    ? `🏷️ 类别已更新：${label}

请回复：
1️⃣ 确认
2️⃣ 再次编辑
3️⃣ 取消`
    : lang === "ta"
    ? `🏷️ வகை புதுப்பிக்கப்பட்டது: ${label}

பதில்:
1️⃣ உறுதி
2️⃣ மீண்டும் திருத்த
3️⃣ ரத்து`
    : `🏷️ Category updated: ${label}

Reply:
1️⃣ Confirm
2️⃣ Edit again
3️⃣ Cancel`
  });
}

async function handlePayment(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim().toUpperCase();
  const ticketId = session.current_ticket_id;
  const lang = session.language ?? "en";

  if (text === "PAY") {
    return res.status(200).json({
      success: true,
      reply_text: buildFollowUpReply(lang, "payment_prompt")
    });
  }

  if (text === "CANCEL") {
    await supabase
      .from("tickets")
      .update({ status: "cancelled" })
      .eq("id", ticketId);

    await supabase
      .from("conversation_sessions")
      .update({
        state: "intake",
        current_ticket_id: null
      })
      .eq("condo_id", session.condo_id)
      .eq("id", session.id)
      .eq("phone_number", session.phone_number);


    return res.status(200).json({
      success: true,
      reply_text: buildFollowUpReply(lang, "cancelled")
    }); 
  }

  return res.status(200).json({
    success: true,
    reply_text: buildFollowUpReply(lang, "invalid_payment")
  });
}

// 🆕 NEW — HANDLE CATEGORY SELECTION
async function handleCategorySelection(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  const map: Record<string, MaintenanceCategory> = {
    "1": "electrical",
    "2": "plumbing",
    "3": "air_conditioning",
    "4": "lighting",
    "5": "sanitary",
    "6": "door_window",
    "7": "ceiling_wall",
    "8": "flooring",
    "9": "pest_control",
    "10": "others"
  };

  const category = map[text];

  if (!category) {
    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "Sila pilih kategori dengan membalas nombor sahaja."
          : lang === "zh"
          ? "请仅回复数字选择类别。"
          : lang === "ta"
          ? "எண் மூலம் வகையைத் தேர்வு செய்யவும்."
          : "Please select a category by replying with a number only."
    });
  }

  const diagnosis_fee = CATEGORY_DIAGNOSIS_FEE[category];

  await supabase
    .from("tickets")
    .update({
      maintenance_category: category,      // 🆕 NEW
      diagnosis_fee,                       // 🆕 NEW
      updated_at: new Date()
    })
    .eq("id", session.current_ticket_id);

  await supabase
    .from("conversation_sessions")
    .update({ state: "awaiting_schedule" }) // 🆕 NEW
    .eq("id", session.id);

  return res.status(200).json({
    success: true,
    reply_text:
      lang === "ms"
        ? `🛠 Kategori dipilih.\nYuran pemeriksaan: RM${diagnosis_fee}\n\nSila pilih slot masa:\n1️⃣ 9am–12pm\n2️⃣ 12pm–3pm\n3️⃣ 3pm–6pm`
        : lang === "zh"
        ? `🛠 已选择类别。\n检查费：RM${diagnosis_fee}\n\n请选择时间段：\n1️⃣ 9am–12pm\n2️⃣ 12pm–3pm\n3️⃣ 3pm–6pm`
        : lang === "ta"
        ? `🛠 வகை தேர்ந்தெடுக்கப்பட்டது.\nசோதனை கட்டணம்: RM${diagnosis_fee}\n\nநேரத்தை தேர்வு செய்யவும்:\n1️⃣ 9am–12pm\n2️⃣ 12pm–3pm\n3️⃣ 3pm–6pm`
        : `🛠 Category selected.\nDiagnosis fee: RM${diagnosis_fee}\n\nPlease choose a time slot:\n1️⃣ 9am–12pm\n2️⃣ 12pm–3pm\n3️⃣ 3pm–6pm`
  });
}

// 🆕 NEW — HANDLE SCHEDULE SELECTION
async function handleScheduleSelection(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  if (!["1", "2", "3"].includes(text)) {
    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "Sila pilih slot dengan membalas 1, 2 atau 3."
          : "Please reply with 1, 2, or 3 to choose a slot."
    });
  }

  const day = getNextWorkingDay();
  const slots = buildSlots(day);
  const chosen = slots[Number(text) - 1];

  await supabase
    .from("tickets")
    .update({
      preferred_slot_start: chosen.start, // 🆕 NEW
      preferred_slot_end: chosen.end,     // 🆕 NEW
      updated_at: new Date()
    })
    .eq("id", session.current_ticket_id);

  await supabase
    .from("conversation_sessions")
    .update({ state: "awaiting_payment" }) // 🆕 NEW
    .eq("id", session.id);

  return res.status(200).json({
    success: true,
    reply_text:
      lang === "ms"
        ? "⏰ Slot dipilih. Sila teruskan pembayaran."
        : "⏰ Time slot selected. Please proceed with payment."
  });
}

// 🆕 NEW — CONTRACTOR ASSIGNMENT (SYSTEM ONLY)
async function handleContractorAssignment(
  _req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const ticketId = session.current_ticket_id;

  const { data: contractor } = await supabase.rpc(
    "pick_next_contractor",
    { ticket_id: ticketId }
  );

  if (!contractor) {
    await supabase
      .from("tickets")
      .update({
        assignment_status: "exhausted",
        refund_status: "pending",
        status: "cancelled_system"
      })
      .eq("id", ticketId);

    return res.status(200).json({ success: true });
  }

  // ✅ BANK-GRADE SLA PERSISTENCE
  const assignedAt = new Date();
  const deadline = new Date(assignedAt.getTime() + 60 * 60 * 1000);

  await supabase
    .from("tickets")
    .update({
      contractor_id: contractor.id,
      assignment_status: "pending",
      assigned_at: assignedAt,
      assignment_deadline_at: deadline
    })
    .eq("id", ticketId);

  return res.status(200).json({ success: true });
}


// 🆕 NEW — HANDLE SCHEDULE SELECTION
async function handleScheduleSelection(
  req: NextApiRequest,
  res: NextApiResponse,
  session: any
) {
  const text = req.body.description_raw?.trim();
  const lang = session.language ?? "en";

  if (!["1", "2", "3"].includes(text)) {
    return res.status(200).json({
      success: true,
      reply_text:
        lang === "ms"
          ? "Sila pilih slot dengan membalas 1, 2 atau 3."
          : "Please reply with 1, 2, or 3 to choose a slot."
    });
  }

  const day = getNextWorkingDay();
  const slots = buildSlots(day);
  const chosen = slots[Number(text) - 1];

  await supabase
    .from("tickets")
    .update({
      preferred_slot_start: chosen.start,
      preferred_slot_end: chosen.end,
      updated_at: new Date()
    })
    .eq("id", session.current_ticket_id);

  await supabase
    .from("conversation_sessions")
    .update({ state: "awaiting_payment" })
    .eq("id", session.id);

  return res.status(200).json({
    success: true,
    reply_text:
      lang === "ms"
        ? "⏰ Slot dipilih. Sila teruskan pembayaran."
        : "⏰ Time slot selected. Please proceed with payment."
  });
}

/*==============================================================================1. ✅ HELPER THROTTLING & GUARDS=================================================================================================*/

/* ================= 🔴✅ HELPER ABUSE / SPAM THROTTLING ================= */
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
      blocked_until: null,
      updated_at: now
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

/* =================✅ HELPER THROTTLE NOTICE ================= */
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

/* ================= ✅ HELPERKEYWORDS MATCH ================= */
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

/* ===== ✅ HELPER GREETING GUARD 1/ NO-INTENT KEYWORDS ===== */
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

/* ===== ✅ HELPER GREETING GUARD 2 ===== */
function isGreetingOnly(text: string): boolean {
  const t = text.toLowerCase().trim();

  // Very short messages are almost always noise
  if (t.length <= 6) return true;

  // Pure greeting
  return GREETING_KEYWORDS.some(
    k => t === k || t.startsWith(k + " ")
  );
}


/*=====================2. ✅ HELPER AI==========================*/

/* ===== 🔴✅ HELPER GREETING GUARD 3/ AI MEANINGFUL ISSUE CHECK (BANK-GRADE) ===== */
async function aiIsMeaningfulIssue(text: string): Promise<boolean> {
  if (!openai) return true; // fail-open

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
You are a property maintenance gatekeeper for a condominium management system.

Your task:
Determine whether the user's message describes a REAL, actionable CONDO MAINTENANCE ISSUE.

Reply ONLY in JSON:
{"is_issue": true|false}

ACCEPT (return true) if the issue involves:
- Building-attached or unit-attached assets
- Fixtures that are part of the property or permanently installed

Examples that MUST be accepted:
- Water leaks, pipes, toilets, sinks, drains
- Electrical wiring, switches, wall sockets
- Ceiling fans
- Air conditioners (AC, aircond)
- Built-in lights or lamps
- Doors, windows, sliding doors
- Walls, ceilings, floors
- Lift, corridor, lobby, parking, staircase
- Any structural, plumbing, electrical, or mechanical issue related to the condo or unit

REJECT (return false) if the issue involves:
- Personal lifestyle or movable appliances
- Items that are NOT permanently attached to the building

Examples that MUST be rejected:
- Television (TV)
- Washing machine
- Refrigerator
- Microwave
- Rice cooker
- Laptop, phone, router
- Furniture (sofa, table, bed)
- Personal electronics or gadgets

IMPORTANT RULES:
- Ceiling fans and air conditioners are NOT personal appliances → they ARE maintenance issues
- If the message mixes accepted and rejected items (e.g. "TV rosak dan paip bocor"), return true
- Greetings, chit-chat, testing messages, or unclear complaints → return false
- Do NOT guess. If unsure but sounds like property maintenance → return true
`
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

/* ================= ✅ HELPER AI TRANSLATE FOR DISPLAY (NO DB WRITE) ================= */
async function aiTranslateForDisplay(
  text: string,
  targetLang: "en" | "ms" | "zh" | "ta"
): Promise<string> {
  if (!openai || targetLang === "en") return text;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Translate the text into the target language. " +
            "Keep it short, natural, and suitable for WhatsApp display. " +
            "Do NOT add explanations. Reply ONLY the translated text."
        },
        {
          role: "user",
          content: `Target language: ${targetLang}\nText: ${text}`
        }
      ]
    });

    return r.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text; // fail-safe
  }
}

/* ================= ✅ HELPER AI LANGUAGE DETECTOR ================= */
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

/* ================= ✅ HELPER AI CLASSIFIER ================= */
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

/* ================= ✅ HELPER MALAYSIAN AI NORMALISER ================= */
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

/*=====================3. ✅ HELPER TEXT/MEDIA==========================*/

/* ================= ✅ HELPER DETECT LANGUAGE ================= */
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

/* ================= ✅ HELPER TRANSCRIPT CLEANER ================= */
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

/* ================= ✅ HELPER TRANSCRIPTION ================= */
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

/* ================= 🔴✅ HELPER MESSAGE NORMALIZER ================= */
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

/*=============== ✅ HELPER FORMAT INTENT LABEL ========================*/
function formatIntentLabel(
  intent: "unit" | "common_area" | "mixed" | "uncertain",
  lang: "en" | "ms" | "zh" | "ta"
): string {
  const map = {
    en: {
      unit: "Unit",
      common_area: "Common area",
      mixed: "Unit & common area",
      uncertain: "Uncertain"
    },
    ms: {
      unit: "Unit kediaman",
      common_area: "Kawasan bersama",
      mixed: "Unit & kawasan bersama",
      uncertain: "Tidak pasti"
    },
    zh: {
      unit: "单位",
      common_area: "公共区域",
      mixed: "单位与公共区域",
      uncertain: "不确定"
    },
    ta: {
      unit: "தனிப்பட்ட யூனிட்",
      common_area: "பொது பகுதி",
      mixed: "யூனிட் மற்றும் பொது பகுதி",
      uncertain: "தெளிவில்லை"
    }
  };

  return map[lang][intent];
}

/*=====================4. ✅ HELPER REPLY BUILDER ==========================*/
/* ================= 🆕 MAINTENANCE CATEGORY CONSTANTS ================= */

// 🆕 NEW — MAINTENANCE CATEGORY TYPES
type MaintenanceCategory =
  | "electrical"
  | "plumbing"
  | "air_conditioning"
  | "lighting"
  | "sanitary"
  | "door_window"
  | "ceiling_wall"
  | "flooring"
  | "pest_control"
  | "lift"
  | "parking"
  | "common_facility"
  | "others";

// 🆕 NEW — CATEGORY → DIAGNOSIS FEE (RM)
const CATEGORY_DIAGNOSIS_FEE: Record<MaintenanceCategory, number> = {
  electrical: 30,
  plumbing: 30,
  air_conditioning: 40,
  lighting: 30,
  sanitary: 30,
  door_window: 30,
  ceiling_wall: 30,
  flooring: 30,
  pest_control: 50,
  lift: 0,
  parking: 0,
  common_facility: 0,
  others: 30
};


/* =================✅ HELPER BANK GRADE REPLY GENERATOR ================= */
function buildReplyText(
  lang: "en" | "ms" | "zh" | "ta",
  type:
  | "greeting"
  | "greeting_soft"
  | "greeting_firm"
  | "intake_received"
  | "confirmed"
  | "non_maintenance",
  ticketId?: string,
  descriptionDisplay?: string,
  intentCategory?: "unit" | "common_area" | "mixed" | "uncertain"
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

if (type === "greeting_soft") {
  switch (lang) {
    case "ms":
      return "Sekadar peringatan kecil 🙂\nSila terangkan masalah penyelenggaraan supaya kami boleh buka tiket untuk anda.";
    case "zh":
      return "小提醒一下 🙂\n请描述维修问题，以便我们为您创建工单。";
    case "ta":
      return "ஒரு சிறிய நினைவூட்டல் 🙂\nடிக்கெட் உருவாக்க, தயவுசெய்து பராமரிப்பு பிரச்சனையை விவரிக்கவும்.";
    default:
      return "Just a quick reminder 🙂\nPlease describe the maintenance issue so we can create a ticket for you.";
  }
}

if (type === "greeting_firm") {
  switch (lang) {
    case "ms":
      return "Untuk meneruskan, kami perlukan penerangan ringkas mengenai masalah penyelenggaraan.\nSelepas itu, kami akan uruskan selebihnya.";
    case "zh":
      return "要继续处理，我们需要您简要说明维修问题。\n收到后，我们将为您安排后续。";
    case "ta":
      return "தொடர, தயவுசெய்து பராமரிப்பு பிரச்சனையை சுருக்கமாக விளக்கவும்.\nமீதியைக் kami uruskan.";
    default:
      return "To proceed, we’ll need a brief description of the maintenance issue.\nOnce received, we’ll take care of the rest.";
  }
}

if (type === "intake_received") {
  const intentLabel = intentCategory
  ? formatIntentLabel(intentCategory, lang)
  : null;

  const issue = descriptionDisplay
    ? `"${descriptionDisplay}"`
    : "";

  switch (lang) {
    case "zh":
      return `🛠 维修工单已记录。
我们理解您的问题是关于 ${issue}

${intentLabel ? `Category: ${intentLabel}\n` : ""}

请回复：
1️⃣ 确认工单
2️⃣ 编辑描述
3️⃣ 取消工单`;

    case "ta":
      return `🛠 பராமரிப்பு டிக்கெட் பதிவு செய்யப்பட்டது.
உங்கள் பிரச்சனை ${issue} தொடர்புடையது என்பதை நாங்கள் புரிந்துகொள்கிறோம்.

${intentLabel ? `வகை: ${intentLabel}\n` : ""}

பதில்:
1️⃣ டிக்கெட்டை உறுதி செய்ய
2️⃣ விளக்கத்தை திருத்த
3️⃣ டிக்கெட்டை ரத்து செய்ய`;

    case "ms":
      return `🛠 Laporan penyelenggaraan telah direkodkan.
Kami memahami bahawa isu anda berkaitan ${issue}

${intentLabel ? `Kategori: ${intentLabel}\n` : ""}

Sila balas:
1️⃣ Sahkan tiket
2️⃣ Edit keterangan
3️⃣ Batalkan tiket`;

    default:
      return `🛠 Maintenance ticket recorded.
We understand that your issue relates to ${issue}

${intentLabel ? `Category: ${intentLabel}\n` : ""}

Please reply:
1️⃣ Confirm ticket
2️⃣ Edit description
3️⃣ Cancel ticket`;
  }
}

  if (type === "non_maintenance") {
  switch (lang) {
    case "ms":
      return (
        "Terima kasih atas mesej anda 😊\n\n" +
        "Kami mengesan bahawa mesej ini mungkin **bukan isu penyelenggaraan**.\n\n" +
        "Contoh isu yang boleh dilaporkan:\n" +
        "• Paip bocor\n" +
        "• Lif rosak\n" +
        "• Lampu tidak menyala\n\n" +
        "Sila hantar masalah penyelenggaraan berkaitan unit atau kawasan bersama. Terima kasih!"
      );

    case "zh":
      return (
        "谢谢您的信息 😊\n\n" +
        "我们发现这条信息**可能不是维修相关问题**。\n\n" +
        "可提交的维修示例：\n" +
        "• 水管漏水\n" +
        "• 电梯故障\n" +
        "• 灯不亮\n\n" +
        "请重新发送与房屋或公共区域维修相关的问题。谢谢！"
      );

    case "ta":
      return (
        "உங்கள் செய்திக்கு நன்றி 😊\n\n" +
        "இது **பராமரிப்பு சம்பந்தமான பிரச்சனை அல்ல** என்று தோன்றுகிறது.\n\n" +
        "உதாரணமாக அனுப்பக்கூடிய பிரச்சனைகள்:\n" +
        "• குழாய் கசிவு\n" +
        "• லிப்ட் பழுது\n" +
        "• விளக்கு எரியவில்லை\n\n" +
        "தயவுசெய்து பராமரிப்பு தொடர்பான பிரச்சனையை அனுப்பவும். நன்றி!"
      );

    default:
      return (
        "Thanks for your message 😊\n\n" +
        "It looks like this may **not be a maintenance-related issue**.\n\n" +
        "Examples of accepted issues:\n" +
        "• Leaking pipe\n" +
        "• Lift not working\n" +
        "• Light not functioning\n\n" +
        "Please send a maintenance issue related to your unit or common area. Thank you!"
      );
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

/* ================= ✅ HELPER FOLLOW-UP REPLY TEXT ================= */
function buildFollowUpReply(
  lang: "en" | "ms" | "zh" | "ta",
  type:
    | "confirm_success"
    | "ask_edit"
    | "cancelled"
    | "payment_prompt"
    | "invalid_confirm"
    | "invalid_payment"
): string {
  switch (type) {
    case "confirm_success":
      switch (lang) {
        case "ms":
          return "✅ Tiket disahkan.\nYuran pemeriksaan: RM30\nBalas PAY untuk teruskan pembayaran.";
        case "zh":
          return "✅ 工单已确认。\n检查费用：RM30\n回复 PAY 以继续付款。";
        case "ta":
          return "✅ டிக்கெட் உறுதிப்படுத்தப்பட்டது.\nசோதனை கட்டணம்: RM30\nபணம் செலுத்த PAY என பதிலளிக்கவும்.";
        default:
          return "✅ Ticket confirmed.\nDiagnosis fee: RM30\nReply PAY to proceed.";
      }

    case "ask_edit":
      switch (lang) {
        case "ms":
          return "✏️ Sila balas dengan penerangan isu yang dikemaskini.";
        case "zh":
          return "✏️ 请回复更新后的问题描述。";
        case "ta":
          return "✏️ தயவுசெய்து திருத்தப்பட்ட பிரச்சனை விளக்கத்தை அனுப்பவும்.";
        default:
          return "✏️ Please reply with the corrected issue description.";
      }

    case "cancelled":
      switch (lang) {
        case "ms":
          return "❌ Tiket telah dibatalkan.";
        case "zh":
          return "❌ 工单已取消。";
        case "ta":
          return "❌ டிக்கெட் ரத்து செய்யப்பட்டது.";
        default:
          return "❌ Ticket cancelled.";
      }

    case "payment_prompt":
      switch (lang) {
        case "ms":
          return "💳 Balas PAY untuk membuat pembayaran atau CANCEL untuk batalkan tiket.";
        case "zh":
          return "💳 回复 PAY 进行付款，或回复 CANCEL 取消工单。";
        case "ta":
          return "💳 பணம் செலுத்த PAY அல்லது ரத்து செய்ய CANCEL என பதிலளிக்கவும்.";
        default:
          return "💳 Reply PAY to proceed or CANCEL to cancel the ticket.";
      }

    case "invalid_confirm":
      switch (lang) {
        case "ms":
          return "Sila balas dengan 1, 2 atau 3 sahaja.";
        case "zh":
          return "请仅回复 1、2 或 3。";
        case "ta":
          return "1, 2 அல்லது 3 மட்டுமே பதிலளிக்கவும்.";
        default:
          return "Please reply with 1, 2, or 3 only.";
      }

    case "invalid_payment":
      switch (lang) {
        case "ms":
          return "Sila balas PAY atau CANCEL sahaja.";
        case "zh":
          return "请仅回复 PAY 或 CANCEL。";
        case "ta":
          return "PAY அல்லது CANCEL மட்டுமே பதிலளிக்கவும்.";
        default:
          return "Please reply PAY or CANCEL only.";
      }
  }
}

/*===================== ✅ HELPER NORMALIZE PHONE ===============================*/
function normalizeWhatsappPhone(input?: string | null): string | null {
  if (!input) return null;

  return input
    .toString()
    .trim()
    .replace(/^whatsapp:/i, "") // remove "whatsapp:"
    .replace(/\s+/g, "")        // remove spaces
    .replace(/-/g, "");         // remove dashes
}

/*===================== ✅ HELPER WORKING DAY & SLOT ===============================*/
// 🆕 NEW — PUBLIC HOLIDAYS (YYYY-MM-DD, extend as needed)
const PUBLIC_HOLIDAYS = [
  "2026-01-01",
  "2026-02-01"
];

// 🆕 NEW
function isSunday(date: Date) {
  return date.getDay() === 0;
}

// 🆕 NEW
function isPublicHoliday(date: Date) {
  const ymd = date.toISOString().slice(0, 10);
  return PUBLIC_HOLIDAYS.includes(ymd);
}

// 🆕 NEW — NEXT WORKING DAY (EXCLUDE SUNDAY & PH)
function getNextWorkingDay(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);

  while (isSunday(d) || isPublicHoliday(d)) {
    d.setDate(d.getDate() + 1);
  }

  d.setHours(0, 0, 0, 0);
  return d;
}

// 🆕 NEW — BUILD 3 FIXED SLOTS
function buildSlots(date: Date) {
  const base = new Date(date);

  const s1 = new Date(base); s1.setHours(9, 0, 0, 0);
  const e1 = new Date(base); e1.setHours(12, 0, 0, 0);

  const s2 = new Date(base); s2.setHours(12, 0, 0, 0);
  const e2 = new Date(base); e2.setHours(15, 0, 0, 0);

  const s3 = new Date(base); s3.setHours(15, 0, 0, 0);
  const e3 = new Date(base); e3.setHours(18, 0, 0, 0);

  return [
    { start: s1, end: e1 },
    { start: s2, end: e2 },
    { start: s3, end: e3 }
  ];
}

/* ================= ✅ HELPER REFUND ================= */

// 🆕 NEW
async function processRefund(ticketId: string) {
  await supabase
    .from("tickets")
    .update({
      refund_status: "processed",
      refunded_at: new Date(),
      refund_reason: "NO_CONTRACTOR_AVAILABLE",
      processed_by: "system"
    })
    .eq("id", ticketId);
}

/*====================================================*/

