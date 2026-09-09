"use server";
import { analytics, jobs } from "@synthos/core";
import { run } from "./_util";

export async function retryJobAction(id: string, confirmedNoPost?: boolean) {
  return run((ctx) => jobs.retryJob(ctx, id, { confirmedNoPost }));
}
export async function cancelJobAction(id: string, reason?: string) {
  return run((ctx) => jobs.cancelJob(ctx, id, reason));
}
export async function markPublishedAction(id: string, postUrl: string, publishedAt?: string) {
  return run((ctx) => jobs.markJobPublished(ctx, id, { postUrl, publishedAt }));
}
export async function holdJobAction(id: string, reason: string) {
  return run((ctx) => jobs.holdJob(ctx, id, reason));
}
export async function releaseJobAction(id: string) {
  return run((ctx) => jobs.releaseJob(ctx, id));
}
export async function retryAnalyticsAction(id: string) {
  return run((ctx) => analytics.retryAnalytics(ctx, id));
}
