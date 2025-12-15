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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Allow POST only
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify request is from Make
  const secret = req.headers["x-make-secret"];
  if (secret !== process.env.MAKE_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // Basic text cleaning (NO AI here)
    const description_clean = description_raw
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    // Create embedding (for duplicate check, ML-ready)
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: description_clean,
    });

    // Insert ticket
    const { data, error } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        description_clean,
        source: "whatsapp",
        status: "new",
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json(error);
    }

    return res.status(200).json({
      ticket_id: data.id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
