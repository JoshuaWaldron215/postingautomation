import { NextResponse } from "next/server";
import { auth, getDb } from "@synthos/core";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) return NextResponse.json({ error: { code: "validation", message: "Email and password are required." } }, { status: 400 });
  const result = await auth.login(getDb(), body.email, body.password);
  if (!result) return NextResponse.json({ error: { code: "unauthorized", message: "That email and password did not match." } }, { status: 401 });
  const res = NextResponse.json({ ok: true, user: { id: result.user.id, name: result.user.name, role: result.user.role } });
  res.cookies.set(SESSION_COOKIE, result.sessionId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return res;
}
