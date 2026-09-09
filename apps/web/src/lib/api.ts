import { NextResponse } from "next/server";
import { AppError, getDb, loadDotEnv, makeCtx, workersService, type Ctx, type Worker } from "@synthos/core";
import { ZodError } from "zod";
import { getCurrentUser, getUserCtx } from "./session";
import { auth } from "@synthos/core";

loadDotEnv();

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorResponse(err: unknown) {
  if (err instanceof AppError) return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, { status: err.httpStatus });
  if (err instanceof ZodError) return NextResponse.json({ error: { code: "validation", message: "Invalid request body.", details: err.issues } }, { status: 400 });
  if (err instanceof Error && err.message === "unauthorized") return NextResponse.json({ error: { code: "unauthorized", message: "Sign in to continue." } }, { status: 401 });
  console.error(err);
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong." } }, { status: 500 });
}

/** Wraps a route handler with auth (user session) and error mapping. */
export function withUser<T extends unknown[]>(handler: (ctx: Ctx, ...args: T) => Promise<Response>) {
  return async (...args: T) => {
    try {
      const ctx = await getUserCtx();
      return await handler(ctx, ...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Wraps a worker-protocol route with bearer-token auth. The ctx actor is the worker. */
export function withWorker<T extends unknown[]>(handler: (ctx: Ctx, worker: Worker, req: Request, ...args: T) => Promise<Response>) {
  return async (req: Request, ...args: T) => {
    try {
      const worker = await workersService.authenticateWorker(getDb(), req.headers.get("authorization"));
      if (!worker) return NextResponse.json({ error: { code: "unauthorized", message: "Invalid or revoked worker token." } }, { status: 401 });
      const ctx = await makeCtx({ db: getDb(), orgId: worker.orgId, actor: { type: "worker", id: worker.id, name: worker.name } });
      return await handler(ctx, worker, req, ...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export { getCurrentUser, auth };
