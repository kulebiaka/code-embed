import { describe, expect, it } from "vitest";
import {
  ConsentRequiredError,
  IndexCorruptError,
  LockedError,
  ModelIntegrityError,
  NoIndexError,
  ProtocolMismatchError,
  ProviderUnavailableError,
} from "./errors";

describe("errors", () => {
  it("are distinguishable Error subclasses with payload", () => {
    const consent = new ConsentRequiredError("api.example.com", "corp");
    expect(consent).toBeInstanceOf(Error);
    expect(consent).toBeInstanceOf(ConsentRequiredError);
    expect(consent.host).toBe("api.example.com");
    expect(consent.provider).toBe("corp");
    expect(consent.name).toBe("ConsentRequiredError");

    const unavailable = new ProviderUnavailableError("rate limited", 1500);
    expect(unavailable.message).toBe("rate limited");
    expect(unavailable.retryAfterMs).toBe(1500);

    const locked = new LockedError(4242);
    expect(locked.pid).toBe(4242);
    expect(locked.message).toContain("4242");

    expect(new NoIndexError("x")).not.toBeInstanceOf(IndexCorruptError);
    expect(new ModelIntegrityError("x").name).toBe("ModelIntegrityError");
    expect(new ProtocolMismatchError("x").name).toBe("ProtocolMismatchError");
  });
});
