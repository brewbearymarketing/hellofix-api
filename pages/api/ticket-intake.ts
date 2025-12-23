import type { NextApiRequest, NextApiResponse } from "next";

/**
 * TEMPORARY DEBUG HANDLER
 * Purpose:
 * 1. Prove API is hit
 * 2. Inspect raw body from Make
 * 3. Confirm voice_url / image_url / Body mapping
 * 4. Eliminate ALL other causes of Bad Request
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Allow browser / health checks
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, note: "GET ignored" });
  }

  try {
    console.log("🔥 HIT API");

    console.log("🔥 METHOD:", req.method);
    console.log("🔥 HEADERS:", req.headers);
    console.log("🔥 RAW BODY (as received):", req.body);

    // Parse body safely
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    console.log("🔥 PARSED BODY:", body);

    const {
      condo_id,
      phone_number,
      description_raw,
      voice_url,
      image_url
    } = body || {};

    console.log("🔥 condo_id:", condo_id);
    console.log("🔥 phone_number:", phone_number);
    console.log("🔥 description_raw:", description_raw);
    console.log("🔥 voice_url:", voice_url);
    console.log("🔥 image_url:", image_url);

    return res.status(200).json({
      ok: true,
      received: {
        condo_id,
        phone_number,
        description_raw,
        voice_url,
        image_url
      }
    });

  } catch (err: any) {
    console.error("🔥 DEBUG ERROR:", err);

    return res.status(500).json({
      error: "Debug handler failed",
      detail: err.message
    });
  }
}
