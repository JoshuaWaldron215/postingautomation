export class AppError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "unauthorized"
      | "conflict"
      | "validation"
      | "stale_fence"
      | "demo_mode"
      | "rate_limited"
      | "internal",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
  get httpStatus(): number {
    switch (this.code) {
      case "not_found":
        return 404;
      case "forbidden":
      case "demo_mode":
        return 403;
      case "unauthorized":
        return 401;
      case "conflict":
      case "stale_fence":
        return 409;
      case "validation":
        return 400;
      case "rate_limited":
        return 429;
      default:
        return 500;
    }
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} was not found.`);
export const forbidden = (msg = "You do not have permission to do that.") => new AppError("forbidden", msg);
export const validation = (msg: string, details?: Record<string, unknown>) => new AppError("validation", msg, details);
export const conflict = (msg: string, details?: Record<string, unknown>) => new AppError("conflict", msg, details);
