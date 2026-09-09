import { revalidatePath } from "next/cache";
import { AppError } from "@synthos/core";
import { getUserCtx } from "@/lib/session";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** Runs a service call as a server action: builds the user ctx, maps errors to plain-language messages, revalidates. */
export async function run<T>(fn: (ctx: Awaited<ReturnType<typeof getUserCtx>>) => Promise<T>, paths: string[] = ["/", "/today", "/content", "/accounts", "/schedule", "/results", "/activity", "/settings"]): Promise<ActionResult<T>> {
  try {
    const ctx = await getUserCtx();
    const data = await fn(ctx);
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    if (err instanceof Error && err.message === "unauthorized") return { ok: false, error: "Your session expired. Sign in again.", code: "unauthorized" };
    console.error(err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
