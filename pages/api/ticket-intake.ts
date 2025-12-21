/* ===== 3️⃣ CREATE TICKET (ALWAYS) ===== */
const { data: ticket, error: insertError } = await supabase
  .from("tickets")
  .insert({
    condo_id,
    unit_id: intent_category === "unit" ? unit_id : null,
    description_raw,
    description_clean: description_raw,
    source: "whatsapp",
    status: "new", // 🔧 FIX 1: enum-safe
    is_common_area: intent_category === "common_area",
    intent_category,
    intent_source,
    intent_confidence,
    diagnosis_fee: intent_category === "unit" ? 30 : 0
  })
  .select()
  .single();

if (insertError || !ticket) {
  throw insertError;
}

/* ===== 5️⃣ EMBEDDING + DUPLICATE LOGIC ===== */
let duplicate_of: string | null = null;
let related_to: string | null = null;

if (openai) {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: description_raw
  });

  const embedding = emb.data[0].embedding;

  // 🔧 FIX 2: verify embedding update
  const { error: embedUpdateError } = await supabase
    .from("tickets")
    .update({ embedding })
    .eq("id", ticket.id);

  if (embedUpdateError) {
    throw embedUpdateError;
  }

  // 🔧 FIX 3: null-safe RPC inputs
  const { data: relation, error: relationError } =
    await supabase.rpc("detect_ticket_relation", {
      query_embedding: embedding,
      condo_filter: condo_id,
      ticket_unit_id: ticket.unit_id ?? null,
      ticket_is_common_area: !!ticket.is_common_area,
      exclude_id: ticket.id,
      similarity_threshold: 0.85
    });

  if (relationError) {
    throw relationError;
  }

  if (relation && relation.length > 0) {
    const r = relation[0];

    if (r.relation_type === "hard_duplicate") {
      duplicate_of = r.related_ticket_id;
    } else if (r.relation_type === "related") {
      related_to = r.related_ticket_id;
    }

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
