import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = req.headers["x-make-secret"];
  if (secret !== process.env.MAKE_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({ error: "Missing fields" });
    }

    /* =========================
       1️⃣ CLEAN TEXT (NO AI)
    ========================= */
    const description_clean = description_raw
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    /* =========================
       2️⃣ EMBED NEW TICKET
    ========================= */
    const embedNew = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: description_clean,
    });

    const newVector = embedNew.data[0].embedding;

    /* =========================
       3️⃣ FETCH OPEN TICKETS ONLY
       Same condo
       Status NOT closed
    ========================= */
    const { data: openTickets } = await supabase
      .from("tickets")
      .select("id, description_clean")
      .eq("condo_id", condo_id)
      .not("status", "in", '("completed","cancelled")');

    let duplicateOf: string | null = null;
    let duplicateScore: number | null = null;

    /* =========================
       4️⃣ SEMANTIC COMPARISON
    ========================= */
    if (openTickets && openTickets.length > 0) {
      const embedExisting = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: openTickets.map(t => t.description_clean),
      });

      embedExisting.data.forEach((item, index) => {
        const score = cosineSimilarity(newVector, item.embedding);

        if (score >= 0.88 && (!duplicateScore || score > duplicateScore)) {
          duplicateScore = score;
          duplicateOf = openTickets[index].id;
        }
      });
    }

    /* =========================
       5️⃣ INSERT TICKET
    ========================= */
    const { data, error } = await supabase
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

    if (error) {
      return res.status(500).json(error);
    }

    return res.status(200).json({
      ticket_id: data.id,
      duplicate: !!duplicateOf,
      duplicate_of: duplicateOf,
      duplicate_score: duplicateScore,
    });

  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
