/** Placeholders for future execution routes. They report no capabilities and refuse to run. */
import type { Capabilities, PublisherAdapter } from "./types";

function notImplemented(kind: string): never {
  throw new Error(`${kind} adapter is not implemented in this version.`);
}

export class PixelAdapter implements PublisherAdapter {
  readonly kind = "pixel" as const;
  readonly executionLabel = "Pixel (future)";
  async capabilities(): Promise<Capabilities> {
    return { canVerifyIdentity: false, canPublish: false, canReconcile: false, canReadMetrics: false, live: false, notes: ["Future adapter: posting through a Pixel device is not implemented."] };
  }
  async checkReadiness() {
    return { ready: false, reason: "Pixel route is not available yet" };
  }
  verifyIdentity(): never {
    return notImplemented("Pixel");
  }
  publish(): never {
    return notImplemented("Pixel");
  }
  reconcile(): never {
    return notImplemented("Pixel");
  }
  readMetrics(): never {
    return notImplemented("Pixel");
  }
}

export class OfficialApiAdapter implements PublisherAdapter {
  readonly kind = "official_api" as const;
  readonly executionLabel = "Official API (future)";
  async capabilities(): Promise<Capabilities> {
    return { canVerifyIdentity: false, canPublish: false, canReconcile: false, canReadMetrics: false, live: false, notes: ["Future adapter: the Meta Graph API route is not implemented."] };
  }
  async checkReadiness() {
    return { ready: false, reason: "Official API route is not available yet" };
  }
  verifyIdentity(): never {
    return notImplemented("Official API");
  }
  publish(): never {
    return notImplemented("Official API");
  }
  reconcile(): never {
    return notImplemented("Official API");
  }
  readMetrics(): never {
    return notImplemented("Official API");
  }
}
