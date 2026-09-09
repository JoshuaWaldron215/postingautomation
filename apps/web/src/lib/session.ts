import { cookies } from "next/headers";
import { cache } from "react";
import { auth, getDb, loadDotEnv, makeCtx, type Ctx, type User } from "@synthos/core";

loadDotEnv();
export const SESSION_COOKIE = "synthos_session";

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  return auth.resolveSession(getDb(), sid);
});

/** Builds a request-scoped service context for the signed-in user. Throws when signed out. */
export const getUserCtx = cache(async (): Promise<Ctx & { user: User }> => {
  const user = await getCurrentUser();
  if (!user) throw new Error("unauthorized");
  const ctx = await makeCtx({ db: getDb(), orgId: user.orgId, actor: auth.userActor(user) });
  return Object.assign(ctx, { user });
});
