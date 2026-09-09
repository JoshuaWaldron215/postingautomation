import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { auth, getDb } from "@synthos/core";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) await auth.logout(getDb(), sid);
  const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
