const domainErrorTag: unique symbol = Symbol.for("sspc.domain-error");

export class DomainError extends Error {
  readonly [domainErrorTag] = true;

  constructor(public code: string, public status = 400, public details?: Record<string, string | number>) {
    super(code);
    this.name = "DomainError";
  }
}

export function isDomainError(value: unknown): value is DomainError {
  if (!value || typeof value !== "object") return false;
  const error = value as DomainError;
  return error[domainErrorTag] === true && typeof error.code === "string" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
}
