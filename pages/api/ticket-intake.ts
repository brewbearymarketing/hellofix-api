import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("🔥 FUNCTION FILE EXECUTED");
  console.log("METHOD:", req.method);
  console.log("ENV OPENAI KEY EXISTS:", !!process.env.OPENAI_API_KEY);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY MISSING AT RUNTIME");
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  console.log("🧠 CALLING OPENAI NOW");

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: "hard test embedding call",
  });

  console.log("✅ OPENAI RESPONDED", embeddingResponse.data[0].embedding.length);

  return res.status(200).json({
    ok: true,
    embedding_length: embeddingResponse.data[0].embedding.length,
  });
}
