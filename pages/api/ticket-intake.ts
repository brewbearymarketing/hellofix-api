/* ===== Duplicate check (NON-FATAL) ===== */
let duplicateOf: string | null = null;
let duplicateScore: number | null = null;

try {
  const validTickets = (openTickets || []).filter(
    t =>
      typeof t.description_clean === "string" &&
      t.description_clean.length > 0
  );

  if (validTickets.length > 0) {
    const texts = validTickets.map(t => t.description_clean);

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
} catch (err) {
  console.error("Duplicate check skipped due to error:", err);
  // IMPORTANT: do NOT throw
}