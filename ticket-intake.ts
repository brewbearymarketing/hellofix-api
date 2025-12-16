import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* =====================================================
   ENV GUARDS (FAIL FAST, NO SILENT CRASH)
===================================================== */
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  MAKE_WEBHOOK_SECRET,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !MAKE_WEBHOOK_SECRET
) {
  throw new Error("Missing required environment variables");
}

/* =====================================================
   CLIENTS
===================================================== */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* =====================================================
   COSINE SIMILARITY (SAFE)
===================================================== */
function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* =====================================================
   API HANDLER
===================================================== */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    /* ---------- METHOD ---------- */
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    /* ---------- AUTH ---------- */
    const secret = req.headers["x-make-secret"];
    if (secret !== MAKE_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /* ---------- BODY VALIDATION ---------- */
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing required fields: condo_id, description_raw",
      });
    }

    /* ---------- CLEAN TEXT (NO AI) ---------- */
    const description_clean = String(description_raw)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    /* ---------- EMBED NEW TICKET ---------- */
    const newEmbedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: description_clean,
    });

    const newVector = newEmbedding.data[0]?.embedding;
    if (!newVector) {
      return res.status(500).json({ error: "Embedding failed" });
    }

    /* =====================================================
       FETCH OPEN TICKETS (NOT CLOSED)
    ===================================================== */
    const { data: openTickets, error: fetchError } = await supabase
      .from("tickets")
      .select("id, description_clean")
      .eq("condo_id", condo_id)
      .neq("status", "completed")
      .neq("status", "cancelled");

    if (fetchError) {
      console.error("Supabase fetch error:", fetchError);
      return res.status(500).json({ error: "Database fetch failed" });
    }

    /* =====================================================
       DUPLICATE CHECK (FULLY GUARDED)
    ===================================================== */
    let duplicateOf: string | null = null;
    let duplicateScore: number | null = null;

    const validTickets = (openTickets || []).filter(
      t =>
        typeof t.description_clean === "string" &&
        t.description_clean.length > 0
    );

    if (validTickets.length > 0) {
      const texts = validTickets.map(t => t.description_clean);

      // NEVER call OpenAI with empty input
      if (texts.length > 0) {
        const existingEmbeddings = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: texts,
        });

        existingEmbeddings.data.forEach((item, index) => {
          const score = cosineSimilarity(newVector, item.embedding);
          if (score >= 0.88 && (!duplicateScore || score > duplicateScore)) {
            duplicateScore = score;
            duplicateOf = validTickets[index].id;
          }
        });
      }
    }

    /* =====================================================
       INSERT TICKET
    ===================================================== */
    const { data: inserted, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        description_clean,
        source: "whatsapp",
        status: duplicateOf ? "duplicate_flagged" : "new",
        duplicate_of: duplicateOf,
        duplicate_score: duplicateScore,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return res.status(500).json({ error: "Ticket insert failed" });
    }

    /* ---------- SUCCESS ---------- */
    return res.status(200).json({
      ticket_id: inserted.id,
      duplicate: Boolean(duplicateOf),
      duplicate_of: duplicateOf,
      duplicate_score: duplicateScore,
    });

  } catch (err: any) {
    console.error("Ticket intake fatal error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err?.message ?? "Unknown error",
    });
  }
}
