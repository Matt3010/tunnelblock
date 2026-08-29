export type DebugPayload = {
  encoding: "utf8" | "base64";
  data: string;
};

export type DebugEvent = {
  ts: string;
  hostname?: string;
  decision?: "allow" | "block";
  latencyMs?: number;
  source?: string;
  protocol?: string;
  error?: string;
  payload?: DebugPayload;
};

export function makeDebugPayload(input: string | Uint8Array): DebugPayload {
  if (typeof input === "string") {
    return { encoding: "utf8", data: input };
  }

  return {
    encoding: "base64",
    data: Buffer.from(input).toString("base64"),
  };
}

export class DebugClient {
  constructor(
    private readonly endpoint?: string,
    private readonly token?: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.endpoint);
  }

  async emit(event: DebugEvent): Promise<void> {
    if (!this.endpoint) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
    } catch {
      // Debug logging must never break filtering.
    } finally {
      clearTimeout(timeout);
    }
  }
}
