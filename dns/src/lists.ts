import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ListSource = {
  id: string;
  url: string;
  enabled: boolean;
  addedAt: string;
  updatedAt: string | null;
  domainCount: number;
  lastError: string | null;
};

export type BlocklistMatch = {
  source: ListSource;
  matchedRule: string;
};

export type ListSourceDiagnostics = ListSource & {
  cachedDomainCount: number;
  uniqueDomainCount: number;
  overlapDomainCount: number;
  healthy: boolean;
};

export type BlocklistDiagnostics = {
  items: ListSourceDiagnostics[];
  configuredCount: number;
  activeCount: number;
  combinedDomainCount: number;
  totalActiveEntries: number;
  duplicateEntries: number;
  unhealthyCount: number;
};

const MAX_LIST_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function atomicWrite(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function normalizeDomain(value: string): string | null {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");

  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    return null;
  }

  return domain;
}

function findSuffixMatch(host: string, rules: Set<string>): string | null {
  let current = host;

  while (true) {
    if (rules.has(current)) return current;
    const dot = current.indexOf(".");
    if (dot === -1) return null;
    current = current.slice(dot + 1);
  }
}

export function parseBlocklist(text: string): string[] {
  const domains = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("@@")) {
      continue;
    }

    let candidate: string | null = null;

    const adblock = line.match(/^\|\|([^\^/$*|]+)\^/);
    if (adblock) {
      candidate = adblock[1];
    } else {
      const hosts = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)/);
      if (hosts) {
        candidate = hosts[1];
      } else if (!/[\s/$*|=]/.test(line)) {
        candidate = line;
      }
    }

    if (!candidate) continue;
    const domain = normalizeDomain(candidate);
    if (domain) domains.add(domain);
  }

  return [...domains].sort();
}

function sourceId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function validateUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") {
    throw new Error("only HTTPS blocklist URLs are allowed");
  }
  url.hash = "";
  return url.toString();
}

export class BlocklistManager {
  private readonly registryPath: string;
  private readonly cacheDir: string;
  private sourceRules = new Map<string, Set<string>>();
  private sourceRulesSignature = "";

  constructor(
    private readonly rulesDir: string,
    private readonly externalBlockPath: string,
  ) {
    this.registryPath = path.join(rulesDir, "sources.json");
    this.cacheDir = path.join(rulesDir, "lists");
    fs.mkdirSync(this.cacheDir, { recursive: true });

    if (!fs.existsSync(this.registryPath)) {
      atomicWrite(this.registryPath, "[]\n");
    }
    if (!fs.existsSync(this.externalBlockPath)) {
      atomicWrite(this.externalBlockPath, "");
    }

    const sources = this.list();
    this.reloadSourceRules(sources);
    this.sourceRulesSignature = this.sourcesSignature(sources);
  }

  list(): ListSource[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  activeCount(): number {
    return this.list().filter(source => source.enabled).length;
  }

  private save(sources: ListSource[]) {
    atomicWrite(this.registryPath, JSON.stringify(sources, null, 2) + "\n");
  }

  private cachePath(id: string): string {
    return path.join(this.cacheDir, `${id}.txt`);
  }

  private rulesFromCache(id: string): Set<string> {
    const file = this.cachePath(id);
    if (!fs.existsSync(file)) return new Set();

    const rules = new Set<string>();
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const domain = normalizeDomain(line);
      if (domain) rules.add(domain);
    }
    return rules;
  }

  private sourcesSignature(sources: ListSource[]): string {
    return sources
      .map(source =>
        [
          source.id,
          source.enabled ? "1" : "0",
          source.updatedAt ?? "",
          String(source.domainCount),
        ].join(":"),
      )
      .join("|");
  }

  private reloadSourceRules(sources: ListSource[]) {
    const next = new Map<string, Set<string>>();
    for (const source of sources) {
      if (!source.enabled) continue;
      next.set(source.id, this.rulesFromCache(source.id));
    }
    this.sourceRules = next;
  }

  private ensureSourceRulesFresh(sources: ListSource[]) {
    const signature = this.sourcesSignature(sources);
    if (signature === this.sourceRulesSignature) return;
    this.reloadSourceRules(sources);
    this.sourceRulesSignature = signature;
  }

  private async download(url: string): Promise<string[]> {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "adblock-general-purpose/1.0",
        accept: "text/plain,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`blocklist HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_LIST_BYTES) {
      throw new Error("blocklist is larger than 25 MB");
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_LIST_BYTES) {
      throw new Error("blocklist is larger than 25 MB");
    }

    const domains = parseBlocklist(body.toString("utf8"));
    if (domains.length === 0) {
      throw new Error("no valid domains found in blocklist");
    }

    return domains;
  }

  private rebuildCombined(sources = this.list()) {
    const combined = new Set<string>();
    const nextSourceRules = new Map<string, Set<string>>();

    for (const source of sources) {
      if (!source.enabled) continue;

      const sourceSet = this.rulesFromCache(source.id);
      nextSourceRules.set(source.id, sourceSet);
      for (const domain of sourceSet) combined.add(domain);
    }

    this.sourceRules = nextSourceRules;
    this.sourceRulesSignature = this.sourcesSignature(sources);

    atomicWrite(
      this.externalBlockPath,
      [...combined].sort().join("\n") + (combined.size ? "\n" : ""),
    );

    return combined.size;
  }

  findMatches(domainValue: string): BlocklistMatch[] {
    const domain = normalizeDomain(domainValue);
    if (!domain) return [];

    const sources = this.list();
    this.ensureSourceRulesFresh(sources);

    const matches: BlocklistMatch[] = [];
    for (const source of sources) {
      if (!source.enabled) continue;
      const rules = this.sourceRules.get(source.id);
      if (!rules) continue;

      const matchedRule = findSuffixMatch(domain, rules);
      if (matchedRule) matches.push({ source, matchedRule });
    }

    return matches;
  }

  findMatch(domainValue: string): BlocklistMatch | null {
    return this.findMatches(domainValue)[0] ?? null;
  }

  diagnostics(): BlocklistDiagnostics {
    const sources = this.list();
    this.ensureSourceRulesFresh(sources);

    const ownership = new Map<string, number>();
    let totalActiveEntries = 0;

    for (const source of sources) {
      if (!source.enabled) continue;
      const rules = this.sourceRules.get(source.id) ?? new Set<string>();
      totalActiveEntries += rules.size;

      for (const domain of rules) {
        ownership.set(domain, (ownership.get(domain) ?? 0) + 1);
      }
    }

    const items = sources.map(source => {
      const cachedRules = this.rulesFromCache(source.id);
      let uniqueDomainCount = 0;
      let overlapDomainCount = 0;

      if (source.enabled) {
        for (const domain of cachedRules) {
          if ((ownership.get(domain) ?? 0) > 1) {
            overlapDomainCount++;
          } else {
            uniqueDomainCount++;
          }
        }
      }

      return {
        ...source,
        cachedDomainCount: cachedRules.size,
        uniqueDomainCount,
        overlapDomainCount,
        healthy: source.lastError === null,
      };
    });

    const combinedDomainCount = ownership.size;

    return {
      items,
      configuredCount: sources.length,
      activeCount: sources.filter(source => source.enabled).length,
      combinedDomainCount,
      totalActiveEntries,
      duplicateEntries: Math.max(0, totalActiveEntries - combinedDomainCount),
      unhealthyCount: sources.filter(source => source.lastError !== null).length,
    };
  }

  async add(urlValue: string): Promise<ListSource> {
    const url = validateUrl(urlValue);
    const id = sourceId(url);
    const sources = this.list();

    if (sources.some(source => source.id === id || source.url === url)) {
      throw new Error("blocklist already exists");
    }

    const domains = await this.download(url);
    atomicWrite(this.cachePath(id), domains.join("\n") + "\n");

    const now = new Date().toISOString();
    const source: ListSource = {
      id,
      url,
      enabled: true,
      addedAt: now,
      updatedAt: now,
      domainCount: domains.length,
      lastError: null,
    };

    sources.push(source);
    this.save(sources);
    this.rebuildCombined(sources);
    return source;
  }

  async refresh(id: string): Promise<ListSource> {
    const sources = this.list();
    const source = sources.find(item => item.id === id);
    if (!source) throw new Error("blocklist not found");

    try {
      const domains = await this.download(source.url);
      atomicWrite(this.cachePath(id), domains.join("\n") + "\n");
      source.updatedAt = new Date().toISOString();
      source.domainCount = domains.length;
      source.lastError = null;
      this.save(sources);
      this.rebuildCombined(sources);
      return source;
    } catch (error) {
      source.lastError = error instanceof Error ? error.message : String(error);
      this.save(sources);
      throw error;
    }
  }

  async refreshAll(): Promise<{ updated: number; failed: number }> {
    const sources = this.list();
    let updated = 0;
    let failed = 0;

    for (const source of sources.filter(item => item.enabled)) {
      try {
        await this.refresh(source.id);
        updated++;
      } catch {
        failed++;
      }
    }

    return { updated, failed };
  }

  setEnabled(id: string, enabled: boolean): ListSource {
    const sources = this.list();
    const source = sources.find(item => item.id === id);
    if (!source) throw new Error("blocklist not found");

    source.enabled = enabled;
    this.save(sources);
    this.rebuildCombined(sources);
    return source;
  }

  remove(id: string): void {
    const sources = this.list();
    const source = sources.find(item => item.id === id);
    if (!source) throw new Error("blocklist not found");

    const next = sources.filter(item => item.id !== id);
    const cache = this.cachePath(id);
    if (fs.existsSync(cache)) fs.unlinkSync(cache);

    this.save(next);
    this.rebuildCombined(next);
  }

  combinedDomainCount(): number {
    if (!fs.existsSync(this.externalBlockPath)) return 0;
    return fs
      .readFileSync(this.externalBlockPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length;
  }
}
