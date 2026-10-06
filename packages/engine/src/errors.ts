export class IndexCorruptError extends Error {
  override name = "IndexCorruptError";
}

export class NoIndexError extends Error {
  override name = "NoIndexError";
}

export class ConsentRequiredError extends Error {
  override name = "ConsentRequiredError";
  constructor(
    public host: string,
    public provider: string,
  ) {
    super(`sending code to external embedding provider "${provider}" (${host}) requires consent`);
  }
}

export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class LockedError extends Error {
  override name = "LockedError";
  constructor(public pid: number) {
    super(`index is locked by another process (pid ${pid})`);
  }
}

export class ModelIntegrityError extends Error {
  override name = "ModelIntegrityError";
}

export class ProtocolMismatchError extends Error {
  override name = "ProtocolMismatchError";
}
