import { NextResponse } from "next/server";

export async function GET() {
  console.log("🧵 WORKER ROUTE IS ALIVE");
  return NextResponse.json({ ok: true });
}
