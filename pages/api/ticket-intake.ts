/* 2️⃣ CREATE EMBEDDING FOR NEW TICKET */
const embeddingResponse = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: description_raw,
});

const newEmbedding = embeddingResponse.data[0].embedding;

/* 3️⃣ STORE EMBEDDING */
await supabase
  .from("tickets")
  .update({ embedding: newEmbedding })
  .eq("id", ticket.id);

/* 4️⃣ FIND MOST SIMILAR OPEN TICKET */
const { data: similarTickets } = await supabase.rpc(
  "match_tickets",
  {
    query_embedding: newEmbedding,
    match_threshold: 0.85,   // IMPORTANT
    match_count: 1,
    condo_filter: condo_id,
    exclude_id: ticket.id,
  }
);

let duplicateOf: string | null = null;

if (similarTickets && similarTickets.length > 0) {
  duplicateOf = similarTickets[0].id;
}

/* 5️⃣ MARK DUPLICATE */
if (duplicateOf) {
  await supabase
    .from("tickets")
    .update({
      is_duplicate: true,
      duplicate_of: duplicateOf,
    })
    .eq("id", ticket.id);
}
