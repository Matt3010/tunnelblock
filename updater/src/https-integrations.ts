import fs from "node:fs";

export const INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ACTION_KINDS = new Set(["certificate", "start", "stop", "summary", "clear"]);

export type IntegrationAction = { id: string; label: string; kind: string; visibleWhen: "always" | "active" | "inactive" };
export type HttpsIntegration = {
  id: string; name: string; description: string; strategy: string; status: string;
  actions: IntegrationAction[]; hostSuffixes: string[];
};

export function parseHttpsRegistry(raw: string): HttpsIntegration[] {
  const payload = JSON.parse(raw) as { version?: unknown; integrations?: unknown };
  if (payload.version !== 1 || !Array.isArray(payload.integrations)) throw new Error("invalid HTTPS integration registry");
  const ids = new Set<string>();
  return payload.integrations.map((value: any) => {
    if (!value || !INTEGRATION_ID.test(value.id) || ids.has(value.id) || typeof value.name !== "string"
      || typeof value.strategy !== "string" || !value.strategy.includes(":")
      || !Array.isArray(value.hostSuffixes) || value.hostSuffixes.length === 0 || !Array.isArray(value.actions)) {
      throw new Error("invalid or duplicate HTTPS integration");
    }
    const actionIds = new Set<string>();
    const actions = value.actions.map((action: any) => {
      const visibleWhen = action?.visibleWhen ?? "always";
      if (!INTEGRATION_ID.test(action?.id) || actionIds.has(action.id) || typeof action.label !== "string"
        || !ACTION_KINDS.has(action.kind) || !["always", "active", "inactive"].includes(visibleWhen)) {
        throw new Error(`invalid HTTPS action for ${value.id}`);
      }
      actionIds.add(action.id);
      return { id: action.id, label: action.label, kind: action.kind, visibleWhen };
    });
    ids.add(value.id);
    return { id: value.id, name: value.name, description: typeof value.description === "string" ? value.description : "",
      strategy: value.strategy, status: typeof value.status === "string" ? value.status : "experimental",
      actions, hostSuffixes: value.hostSuffixes.filter((host: unknown) => typeof host === "string") };
  });
}

export function loadHttpsRegistry(file: string): HttpsIntegration[] {
  return parseHttpsRegistry(fs.readFileSync(file, "utf8"));
}

export function validIntegrationAction(integration: HttpsIntegration, actionId: string): boolean {
  return INTEGRATION_ID.test(actionId) && integration.actions.some(action => action.id === actionId);
}

export function summarizeHttpsObservation(raw: string) {
  const counts: Record<string, number> = {};
  const hosts = new Set<string>();
  for (const line of raw.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (typeof record.event !== "string") continue;
      counts[record.event] = (counts[record.event] ?? 0) + 1;
      if (typeof record.host === "string") hosts.add(record.host);
      if (typeof record.sni === "string") hosts.add(record.sni);
    } catch {}
  }
  const tlsClientHello = counts.tls_clienthello ?? 0;
  const tlsEstablishedClient = counts.tls_established_client ?? 0;
  const tlsEstablishedServer = counts.tls_established_server ?? 0;
  const tlsFailedClient = counts.tls_failed_client ?? 0;
  const tlsFailedServer = counts.tls_failed_server ?? 0;
  const httpRequests = counts.http_request ?? 0;
  const httpResponses = counts.http_response ?? 0;
  return { tlsClientHello, tlsEstablishedClient, tlsEstablishedServer, tlsFailedClient, tlsFailedServer,
    tlsEstablished: tlsEstablishedClient,
    tlsFailed: tlsFailedClient + tlsFailedServer, httpRequests, httpResponses, uniqueHosts: hosts.size,
    likelyCertificatePinning: tlsClientHello > 0 && (tlsFailedClient + tlsFailedServer) > 0
      && tlsEstablishedClient === 0 && httpRequests === 0 };
}
