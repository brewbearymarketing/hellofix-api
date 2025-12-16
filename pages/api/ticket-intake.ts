import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  return res.status(200).json({
    DEPLOYMENT_CHECK: "THIS IS THE NEW CODE",
    method: req.method,
    timestamp: new Date().toISOString(),
  });
}
