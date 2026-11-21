/**
 * kimi-code-web-search — Import credentials, provider endpoints, routing, and search mode
 * from a local Pi agent directory (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 *
 * Reads:
 *  - `auth.json` (`typesafe`, `openrouter` API keys used by `always-search.ts`)
 *  - `web-search.json` (provider API keys, base URLs, and routing used by `pi-web-access`)
 *  - `search-mode.json` (`always` / `smart` / `auto` / `off` used by `always-search.ts`)
 *
 * Secret values are written directly to `credentials.json` (0600) and are NEVER
 * returned in `PiImportView` or error messages.
 * @module
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPool } from "./pool.ts";
import { credRefOf } from "./providers/index.ts";
import type { OutboundAuthorization } from "./provider-transport.ts";
import type { PiImportView, SearchMode } from "../shared/api-types.ts";

export interface PiImportDeps {
  readConfig: () => Record<string, unknown>;
  writeConfig: (patch: Record<string, unknown>) => Promise<void>;
  readCredential: (ref: string) => Promise<{ value?: string }>;
  writeCredential: (ref: string, value: string) => Promise<void>;
  setGlobalMode?: (mode: SearchMode) => void;
}

const SEARCH_KEY_FIELDS: ReadonlyArray<{ field: string; provider: string }> = [
  { field: "exaApiKey", provider: "exa" },
  { field: "tavilyApiKey", provider: "tavily" },
  { field: "braveApiKey", provider: "brave" },
  { field: "youApiKey", provider: "you" },
  { field: "firecrawlApiKey", provider: "firecrawl" },
  { field: "parallelApiKey", provider: "parallel" },
  { field: "jinaApiKey", provider: "jina" },
  { field: "keenableApiKey", provider: "keenable" },
];

const SEARCH_URL_FIELDS: ReadonlyArray<{ field: string; provider: string }> = [
  { field: "exaBaseUrl", provider: "exa" },
  { field: "tavilyBaseUrl", provider: "tavily" },
  { field: "braveBaseUrl", provider: "brave" },
  { field: "youBaseUrl", provider: "you" },
  { field: "firecrawlBaseUrl", provider: "firecrawl" },
  { field: "parallelBaseUrl", provider: "parallel" },
  { field: "jinaSearchBaseUrl", provider: "jina" },
  { field: "keenableBaseUrl", provider: "keenable" },
  { field: "searxngBaseUrl", provider: "searxng" },
];

const SUPPORTED_ROUTING_PROVIDERS = new Set([
  "exa",
  "tavily",
  "brave",
  "you",
  "firecrawl",
  "parallel",
  "jina",
  "keenable",
  "searxng",
]);

const SUPPORTED_FETCH_PROVIDERS = new Set([
  "exa",
  "tavily",
  "firecrawl",
  "parallel",
  "jina",
  "you",
  "http",
]);

function extractRoutingList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { providers?: unknown }).providers)
      ? (raw as { providers: unknown[] }).providers
      : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim().toLowerCase());
    }
  }
  return out;
}

export function resolvePiAgentDir(override?: string): string {
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), ".pi", "agent");
}

function readJsonRecord(filePath: string): { exists: boolean; data?: Record<string, unknown>; error?: string } {
  if (!fs.existsSync(filePath)) return { exists: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, error: "not-an-object" };
    }
    return { exists: true, data: parsed as Record<string, unknown> };
  } catch {
    return { exists: true, error: "invalid-json" };
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function extractLiteralKeys(raw: unknown): { keys: string[]; skippedReason?: string } {
  const candidates: string[] = [];
  if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed) candidates.push(trimmed);
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) {
        candidates.push(item.trim());
      }
    }
  } else if (raw !== undefined && raw !== null) {
    return { keys: [], skippedReason: "unsupported-value" };
  }

  const keys: string[] = [];
  let skippedReason: string | undefined;
  for (const item of candidates) {
    if (item.startsWith("$$") || item.startsWith("$!")) {
      keys.push(item.slice(1));
    } else if (item.startsWith("!") || item.startsWith("$")) {
      skippedReason = "dynamic-command-or-env-ref";
    } else {
      keys.push(item);
    }
  }
  return { keys, ...(skippedReason && keys.length === 0 ? { skippedReason } : {}) };
}

function extractAuthEntryKeys(entry: unknown): { keys: string[]; skippedReason?: string } {
  if (typeof entry === "string") return extractLiteralKeys(entry);
  if (Array.isArray(entry)) {
    const merged: string[] = [];
    let lastReason: string | undefined;
    for (const item of entry) {
      const res = extractAuthEntryKeys(item);
      merged.push(...res.keys);
      if (res.skippedReason) lastReason = res.skippedReason;
    }
    return { keys: merged, ...(merged.length === 0 && lastReason ? { skippedReason: lastReason } : {}) };
  }
  if (!entry || typeof entry !== "object") return { keys: [] };
  const record = entry as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "api_key") {
    return { keys: [], skippedReason: `unsupported-auth-type:${record.type}` };
  }
  const raw = record.key ?? record.apiKey ?? record.token;
  return extractLiteralKeys(raw);
}

async function mergeCredentialKeys(
  deps: PiImportDeps,
  ref: string,
  incoming: string[],
): Promise<boolean> {
  if (incoming.length === 0) return false;
  const existing = await deps.readCredential(ref);
  const current = buildPool(existing.value ?? "").map((e) => e.key);
  const seen = new Set(current);
  let added = 0;
  for (const key of incoming) {
    if (!seen.has(key)) {
      seen.add(key);
      current.push(key);
      added += 1;
    }
  }
  if (added === 0 && existing.value) {
    return true;
  }
  await deps.writeCredential(ref, current.join(","));
  return true;
}

function parseSafeBaseUrl(raw: unknown, allowHttp: boolean): { url?: string; isLoopback?: boolean; isHttp?: boolean; skippedReason?: string } {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { skippedReason: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { skippedReason: "unsupported-protocol" };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { skippedReason: "unsafe-url-parts" };
  }
  const loopback = isLoopbackHost(parsed.hostname);
  const isHttp = parsed.protocol === "http:";
  if (isHttp && !loopback && !allowHttp) {
    return { skippedReason: "non-loopback-http" };
  }
  return {
    url: parsed.href.replace(/\/+$/, ""),
    isLoopback: loopback,
    isHttp,
  };
}

export async function importFromPi(
  deps: PiImportDeps,
  options: { piDir?: string } = {},
): Promise<PiImportView> {
  const piDir = resolvePiAgentDir(options.piDir);
  const result: PiImportView = {
    piDir,
    importedSearchProviders: [],
    importedSmartProviders: [],
    importedBaseUrls: [],
    skipped: [],
  };

  // 1. Import Jev / OpenRouter credentials from auth.json (used by always-search.ts)
  const authDoc = readJsonRecord(path.join(piDir, "auth.json"));
  if (authDoc.error) {
    result.skipped.push({ source: "auth.json", reason: authDoc.error });
  } else if (authDoc.data) {
    for (const [piProvider, ref, label] of [
      ["typesafe", "WEB_TOOLS_TYPESAFE", "typesafe"],
      ["openrouter", "WEB_TOOLS_OPENROUTER", "openrouter"],
    ] as const) {
      if (!(piProvider in authDoc.data)) continue;
      const extracted = extractAuthEntryKeys(authDoc.data[piProvider]);
      if (extracted.keys.length > 0) {
        await mergeCredentialKeys(deps, ref, extracted.keys);
        result.importedSmartProviders.push(label);
      } else if (extracted.skippedReason) {
        result.skipped.push({ source: `auth.json:${piProvider}`, reason: extracted.skippedReason });
      }
    }
  }

  // 2. Import search keys, endpoints, and routing from web-search.json (used by pi-web-access)
  const webSearchDoc = readJsonRecord(path.join(piDir, "web-search.json"));
  const cfg = deps.readConfig();
  const configPatch: Record<string, unknown> = {};
  const nextBaseUrls = { ...((cfg.providerBaseUrls as Record<string, string>) ?? {}) };
  const nextAuths = Array.isArray(cfg.outboundAuthorizations)
    ? [...(cfg.outboundAuthorizations as OutboundAuthorization[])]
    : [];
  let baseUrlsChanged = false;
  let authsChanged = false;

  if (webSearchDoc.error) {
    result.skipped.push({ source: "web-search.json", reason: webSearchDoc.error });
  } else if (webSearchDoc.data) {
    const ws = webSearchDoc.data;
    const allowHttpBaseUrls = ws.allowHttpBaseUrls === true;

    for (const { field, provider } of SEARCH_KEY_FIELDS) {
      if (!(field in ws)) continue;
      const extracted = extractLiteralKeys(ws[field]);
      if (extracted.keys.length > 0) {
        await mergeCredentialKeys(deps, credRefOf(provider), extracted.keys);
        result.importedSearchProviders.push(provider);
      } else if (extracted.skippedReason) {
        result.skipped.push({ source: `web-search.json:${field}`, reason: extracted.skippedReason });
      }
    }

    for (const { field, provider } of SEARCH_URL_FIELDS) {
      if (!(field in ws)) continue;
      const parsed = parseSafeBaseUrl(ws[field], allowHttpBaseUrls || provider === "searxng");
      if (parsed.url) {
        nextBaseUrls[provider] = parsed.url;
        baseUrlsChanged = true;
        result.importedBaseUrls.push(provider);
        if (provider === "searxng" && parsed.isLoopback) {
          const u = new URL(parsed.url);
          const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
          const already = nextAuths.some(
            (a) => a.host.toLowerCase() === u.hostname.toLowerCase() && (a.port === undefined || a.port === port),
          );
          if (!already) {
            nextAuths.push({
              host: u.hostname,
              port,
              allowPrivate: true,
              allowHttp: parsed.isHttp === true,
              note: "Imported from Pi SearXNG config",
            });
            authsChanged = true;
          }
        }
      } else if (parsed.skippedReason) {
        result.skipped.push({ source: `web-search.json:${field}`, reason: parsed.skippedReason });
      }
    }

    const routingList = extractRoutingList(ws.searchRouting);
    const rawRouting: string[] = [];
    if (typeof ws.defaultProvider === "string" && ws.defaultProvider.trim()) {
      rawRouting.push(ws.defaultProvider.trim().toLowerCase());
    }
    rawRouting.push(...routingList);
    const validRouting: string[] = [];
    for (const item of rawRouting) {
      if (SUPPORTED_ROUTING_PROVIDERS.has(item)) {
        if (!validRouting.includes(item)) validRouting.push(item);
      } else {
        result.skipped.push({
          source: `web-search.json:searchRouting:${item}`,
          reason: "unsupported-search-provider",
        });
      }
    }
    if (validRouting.length > 0) {
      configPatch.defaultProvider = validRouting[0];
      // Only replace the fallback chain when Pi actually supplies a routing
      // list; a bare defaultProvider must not wipe an existing fallbackOrder.
      if (routingList.length > 0) {
        configPatch.fallbackOrder = validRouting.slice(1);
      }
      result.importedRouting = {
        defaultProvider: validRouting[0],
        ...(routingList.length > 0 ? { fallbackOrder: validRouting.slice(1) } : {}),
      };
    }

    const rawFetch = extractRoutingList(ws.fetchRouting);
    if (rawFetch.length > 0) {
      const validFetch: string[] = [];
      for (const rawItem of rawFetch) {
        const item = rawItem === "builtin-http" ? "http" : rawItem;
        if (SUPPORTED_FETCH_PROVIDERS.has(item)) {
          if (!validFetch.includes(item)) validFetch.push(item);
        } else {
          result.skipped.push({
            source: `web-search.json:fetchRouting:${rawItem}`,
            reason: "unsupported-fetch-provider",
          });
        }
      }
      if (validFetch.length > 0) {
        configPatch.fetchOrder = validFetch;
        result.importedFetchOrder = validFetch;
      }
    }
  }

  // 3. Import search mode from search-mode.json (used by always-search.ts)
  const modeDoc = readJsonRecord(path.join(piDir, "search-mode.json"));
  if (modeDoc.error) {
    result.skipped.push({ source: "search-mode.json", reason: modeDoc.error });
  } else if (modeDoc.data && typeof modeDoc.data.mode === "string") {
    const rawMode = modeDoc.data.mode.trim().toLowerCase();
    const mapped: SearchMode | undefined =
      rawMode === "always" ? "required"
      : rawMode === "smart" ? "smart"
      : rawMode === "auto" ? "auto"
      : rawMode === "off" ? "off"
      : undefined;
    if (mapped) {
      deps.setGlobalMode?.(mapped);
      result.importedMode = mapped;
    } else {
      result.skipped.push({ source: "search-mode.json:mode", reason: "unknown-mode" });
    }
  }

  if (baseUrlsChanged) configPatch.providerBaseUrls = nextBaseUrls;
  if (authsChanged) configPatch.outboundAuthorizations = nextAuths;
  if (Object.keys(configPatch).length > 0) {
    await deps.writeConfig(configPatch);
  }

  return result;
}
