import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { condo_id, description_raw } = req.body;

    if (!condo_id || !description_raw) {
      return res.status(400).json({
        error: "Missing condo_id or description_raw",
      });
    }

    /* 1️⃣ INSERT TICKET FIRST (ALWAYS) */
    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        condo_id,
        description_raw,
        description_clean: description_raw,
        source: "whatsapp",
        status: "new",
        is_common_area: false,
      })
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    /* 2️⃣ FETCH OPEN TICKETS IN SAME CONDO */
    const { data: openTickets } = await supabase
      .from("tickets")
      .select("id, description_clean")
      .eq("condo_id", condo_id)
      .neq("id", ticket.id)
      .neq("status", "closed")
      .limit(10);

    /* 3️⃣ SEMANTIC DUPLICATE CHECK (BEST-EFFORT) */
    let duplicateOf: string | null = null;

    if (openTickets && openTickets.length > 0) {
      try {
        const prompt = `
New issue:
"${description_raw}"

Existing issues:
${openTickets
  .map((t) => `- (${t.id}) ${t.description_clean}`)
  .join("\n")}

Question:
Is the new issue the same problem as any existing issue?
Answer ONLY with the ticket ID or "NONE".
`;

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        });

        const answer =
          completion.choices[0].message.content?.trim();

        if (
          answer &&
          answer !== "NONE" &&
          openTickets.some((t) => t.id === answer)
        ) {
          duplicateOf = answer;
        }
      } catch (aiErr) {
        // AI failure must NEVER break intake
        console.error("Duplicate check failed:", aiErr);
      }
    }

    /* 4️⃣ UPDATE TICKET IF DUPLICATE */
    if (duplicateOf) {
      await supabase
        .from("tickets")
        .update({
          is_duplicate: true,
          duplicate_of: duplicateOf,
        })
        .eq("id", ticket.id);
    }

    return res.status(200).json({
      success: true,
      ticket_id: ticket.id,
      is_duplicate: !!duplicateOf,
      duplicate_of: duplicateOf,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Internal Server Error",
      detail: err.message,
    });
  }
}
