import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.status(200).json({
    ok: true,
    message: "Ticket intake reached",
    method: req.method,
    headers: req.headers,
    rawBodyType: typeof req.body,
    rawBody: req.body,
  });
}
