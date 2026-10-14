export * from "./Field";
export * from "./Link";
export * from "./OAuthButtons";
export * from "./Shell";

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Please try again.";
