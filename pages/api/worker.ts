import type { NextApiRequest, NextApiResponse } from "next";

export default async function worker(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("🧵 WORKER ALIVE");
  return res.status(200).json({ ok: true });
}
