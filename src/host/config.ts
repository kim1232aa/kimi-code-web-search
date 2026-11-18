/**
 * kimi-web-tools — Host configuration: settings namespace + native TypeScript validation.
 *
 * The config (non-secret knobs) lives in `config.json` (via LocalStorage) or the
 * host settings service. API keys live in `credentials.json` (`WEB_TOOLS_*` refs).
 * @module
 */
import type { WebToolsContext } from "./context-types.ts";
import type { QuotaSnapshot } from "./quota.ts";
import type { StoredProviderOptions } from "../shared/provider-options.ts";
import type { RequiredEvidence, SearchRoutingPolicy, SmartSearchSettings } from "../shared/api-types.ts";
import type { CustomProviderConfig } from "../shared/custom-provider-types.ts";
import type { OutboundAuthorization } from "./provider-transport.ts";
import { loadCustomProviders } from "./custom-provider-schema.ts";

/** Persistent search routing policy id (shared with the client card). */
export type ToolSearchRoutingPolicy = SearchRoutingPolicy;

/** Settings namespace for this plugin. */
export const SETTINGS_NS = "dsh-web-tools";

/** Default provider when nothing is configured. */
export const DEFAULT_PROVIDER = "exa";

export const DEFAULT_SMART_SEARCH: SmartSearchSettings = {
  enabled: true,
  provider: "typesafe",
  model: "jev-latest",
  baseUrl: "",
  timeoutMs: 1500,
  threshold: 0.5,
  failOpen: true,
  enableTranscriptContext: true,
};

/**
 * Explicit defaults for `WebToolsSettings`.
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  defaultProvider: DEFAULT_PROVIDER,
  providerAttemptTimeoutMs: 10000,
  fallbackOrder: [] as string[],
  fetchOrder: [] as string[],
  providerBaseUrls: {} as Record<string, string>,
  providerEnabled: {} as Record<string, boolean>,
  platformEnabled: { xiaohongshu: true, x: true } as Record<string, boolean>,
  providerOptions: {} as StoredProviderOptions,
  braveQuotaCache: {} as Record<string, QuotaSnapshot>,
  searchRoutingPolicy: "ordered" as ToolSearchRoutingPolicy,
  smartSearch: { ...DEFAULT_SMART_SEARCH },
  exemptWhenNoProvider: true,
  recognizeExternalWebTools: true,
  requiredEvidence: "search" as RequiredEvidence,
  customProviders: [] as CustomProviderConfig[],
  outboundAuthorizations: [
    { host: "127.0.0.1", port: 8080, allowPrivate: true, allowHttp: true, note: "SearXNG default instance" },
    { host: "localhost", port: 8080, allowPrivate: true, allowHttp: true, note: "SearXNG default instance" },
  ] as OutboundAuthorization[],
};

/** Resolved settings shape (explicit interface — portable in emitted d.ts). */
export interface WebToolsSettings {
  enabled: boolean;
  defaultProvider: string;
  providerAttemptTimeoutMs: number;
  fallbackOrder: string[];
  fetchOrder: string[];
  providerBaseUrls: Record<string, string>;
  providerEnabled: Record<string, boolean>;
  platformEnabled: Record<string, boolean>;
  providerOptions: StoredProviderOptions;
  /** Brave per-key quota snapshots captured from search response headers. */
  braveQuotaCache: Record<string, QuotaSnapshot>;
  /** Search routing policy (see shared api-types). */
  searchRoutingPolicy: ToolSearchRoutingPolicy;
  smartSearch: SmartSearchSettings;
  exemptWhenNoProvider: boolean;
  recognizeExternalWebTools: boolean;
  /** What settles a required turn: a real search only, or a search or URL read. */
  requiredEvidence: RequiredEvidence;
  /** Operator-defined custom search sources (Issue #9). */
  customProviders: CustomProviderConfig[];
  /** Operator-granted outbound destinations for internal gateways / private IPs. */
  outboundAuthorizations?: OutboundAuthorization[];
}

function unwrapConfig(val: unknown): unknown {
  if (val && typeof (val as any).get === "function") {
    return unwrapConfig((val as any).get());
  }
  if (Array.isArray(val)) {
    return val.map(unwrapConfig);
  }
  if (val !== null && typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = unwrapConfig(v);
    }
    return res;
  }
  return val;
}

/**
 * Keep only usable base-URL overrides.
 *
 * A malformed override must never reach an adapter: an entry that is not an
 * absolute http(s) URL is dropped (which restores the official endpoint) rather
 * than being passed down and failing at request time.
 */
export function sanitizeBaseUrlOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (parsed.username || parsed.password) continue;
      out[key] = parsed.href.replace(/\/+$/, "");
    } catch {
      continue;
    }
  }
  return out;
}

function sanitizeBooleanDict(value: unknown, fallback: Record<string, boolean> = {}): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const out: Record<string, boolean> = { ...fallback };
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function sanitizeRecordDict<T = unknown>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v as T;
  }
  return out;
}

function sanitizeFetchOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.fetchOrder];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    const normalized = trimmed === "builtin-http" ? "http" : trimmed;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function validateSmartSearchSettings(value: unknown): SmartSearchSettings {
  const settings = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<SmartSearchSettings>
    : {};
  return {
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULT_SMART_SEARCH.enabled,
    provider: settings.provider === "typesafe" || settings.provider === "openrouter" || settings.provider === "openai-compatible"
      ? settings.provider
      : DEFAULT_SMART_SEARCH.provider,
    model: typeof settings.model === "string" && settings.model.trim().length > 0
      ? settings.model.trim()
      : DEFAULT_SMART_SEARCH.model,
    baseUrl: sanitizeBaseUrlOverrides({ smartSearch: settings.baseUrl }).smartSearch ?? DEFAULT_SMART_SEARCH.baseUrl,
    timeoutMs: typeof settings.timeoutMs === "number" && Number.isFinite(settings.timeoutMs)
      ? Math.min(10000, Math.max(300, Math.round(settings.timeoutMs)))
      : DEFAULT_SMART_SEARCH.timeoutMs,
    threshold: typeof settings.threshold === "number" && Number.isFinite(settings.threshold)
      ? Math.min(0.99, Math.max(0.1, settings.threshold))
      : DEFAULT_SMART_SEARCH.threshold,
    failOpen: typeof settings.failOpen === "boolean" ? settings.failOpen : DEFAULT_SMART_SEARCH.failOpen,
    enableTranscriptContext: typeof settings.enableTranscriptContext === "boolean"
      ? settings.enableTranscriptContext
      : DEFAULT_SMART_SEARCH.enableTranscriptContext,
  };
}

/**
 * Native TypeScript validator and normalizer for `WebToolsSettings`.
 * Replaces `@deepseek-ai/schemastery` with zero external dependencies.
 */
export function validateWebToolsSettings(rawInput?: unknown): WebToolsSettings {
  const unwrapped = (unwrapConfig(rawInput) as Partial<WebToolsSettings>) ?? {};
  const enabled = typeof unwrapped.enabled === "boolean" ? unwrapped.enabled : DEFAULT_SETTINGS.enabled;
  const defaultProvider =
    typeof unwrapped.defaultProvider === "string" && unwrapped.defaultProvider.trim().length > 0
      ? unwrapped.defaultProvider.trim()
      : DEFAULT_SETTINGS.defaultProvider;

  let providerAttemptTimeoutMs = DEFAULT_SETTINGS.providerAttemptTimeoutMs;
  if (typeof unwrapped.providerAttemptTimeoutMs === "number" && Number.isFinite(unwrapped.providerAttemptTimeoutMs)) {
    providerAttemptTimeoutMs = Math.min(60000, Math.max(1000, Math.round(unwrapped.providerAttemptTimeoutMs)));
  }

  const fallbackOrder = Array.isArray(unwrapped.fallbackOrder)
    ? unwrapped.fallbackOrder.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [...DEFAULT_SETTINGS.fallbackOrder];

  const fetchOrder = sanitizeFetchOrder(unwrapped.fetchOrder);

  const searchRoutingPolicy: ToolSearchRoutingPolicy =
    unwrapped.searchRoutingPolicy === "ordered" ||
    unwrapped.searchRoutingPolicy === "round-robin" ||
    unwrapped.searchRoutingPolicy === "random"
      ? unwrapped.searchRoutingPolicy
      : DEFAULT_SETTINGS.searchRoutingPolicy;

  return {
    enabled,
    defaultProvider,
    providerAttemptTimeoutMs,
    fallbackOrder,
    fetchOrder,
    providerBaseUrls: sanitizeBaseUrlOverrides(unwrapped.providerBaseUrls),
    providerEnabled: sanitizeBooleanDict(unwrapped.providerEnabled),
    platformEnabled: sanitizeBooleanDict(unwrapped.platformEnabled, DEFAULT_SETTINGS.platformEnabled),
    providerOptions: sanitizeRecordDict(unwrapped.providerOptions) as StoredProviderOptions,
    braveQuotaCache: sanitizeRecordDict<QuotaSnapshot>(unwrapped.braveQuotaCache),
    searchRoutingPolicy,
    smartSearch: validateSmartSearchSettings(unwrapped.smartSearch),
    exemptWhenNoProvider: typeof unwrapped.exemptWhenNoProvider === "boolean"
      ? unwrapped.exemptWhenNoProvider
      : DEFAULT_SETTINGS.exemptWhenNoProvider,
    recognizeExternalWebTools: typeof unwrapped.recognizeExternalWebTools === "boolean"
      ? unwrapped.recognizeExternalWebTools
      : DEFAULT_SETTINGS.recognizeExternalWebTools,
    requiredEvidence: unwrapped.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : DEFAULT_SETTINGS.requiredEvidence,
    customProviders: loadCustomProviders(unwrapped.customProviders),
    outboundAuthorizations: sanitizeOutboundAuthorizations(unwrapped.outboundAuthorizations),
  };
}

/**
 * Per-entry validation for outbound authorizations: a malformed entry is
 * dropped rather than persisted, because the transport layer reads
 * `allowPrivate`/`allowHttp` as truthy booleans — a string like `"false"`
 * would otherwise grant private-network access, and a non-string `host`
 * would throw at request time.
 */
function sanitizeOutboundAuthorizations(input: unknown): OutboundAuthorization[] {
  const fallback = [...DEFAULT_SETTINGS.outboundAuthorizations];
  if (!Array.isArray(input)) return fallback;
  const out: OutboundAuthorization[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.host !== "string" || !candidate.host.trim()) continue;
    const port = candidate.port;
    if (port !== undefined && !(typeof port === "number" && Number.isSafeInteger(port) && port >= 1 && port <= 65535)) continue;
    const allowPrivate = candidate.allowPrivate;
    if (allowPrivate !== undefined && typeof allowPrivate !== "boolean") continue;
    const allowHttp = candidate.allowHttp;
    if (allowHttp !== undefined && typeof allowHttp !== "boolean") continue;
    const note = candidate.note;
    if (note !== undefined && typeof note !== "string") continue;
    out.push({
      host: candidate.host.trim(),
      ...(port !== undefined ? { port } : {}),
      ...(allowPrivate !== undefined ? { allowPrivate } : {}),
      ...(allowHttp !== undefined ? { allowHttp } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }
  return out;
}

export interface NativeSchema<T> {
  (input?: unknown): T;
  validate: (input?: unknown) => T;
  meta: { volatile: boolean };
}

/**
 * Native schema object replacing `@deepseek-ai/schemastery` while maintaining
 * backwards-compatible shape (`Config(val)`, `Config.validate(val)`, `Config.meta`).
 */
export const Config: NativeSchema<WebToolsSettings> = Object.assign(
  (input?: unknown) => validateWebToolsSettings(input),
  {
    validate: (input?: unknown) => validateWebToolsSettings(input),
    meta: { volatile: true },
  },
);

/** A settings-scope handle: current value + write path. */
export interface ConfigHandle {
  /** Resolve the current effective section (re-read each call -> live edits apply). */
  read: () => WebToolsSettings;
  /** Write a partial patch into the namespace; resolves when persisted. */
  write: (patch: Partial<WebToolsSettings>) => Promise<void>;
  /** Called once the settings namespace is mounted. */
  onMounted: (cb: () => void) => void;
}

/**
 * Register the settings namespace; returns a handle for reads (live) and
 * Host-side writes.
 */
export function installConfig(ctx: WebToolsContext, initialConfig?: unknown): ConfigHandle {
  const unwrapped = (unwrapConfig(initialConfig) as Partial<WebToolsSettings>) ?? {};
  const validated = validateWebToolsSettings(unwrapped);
  const configured: WebToolsSettings = {
    ...DEFAULT_SETTINGS,
    ...unwrapped,
    fetchOrder: validated.fetchOrder,
    smartSearch: validated.smartSearch,
    exemptWhenNoProvider: validated.exemptWhenNoProvider,
    recognizeExternalWebTools: validated.recognizeExternalWebTools,
    requiredEvidence: validated.requiredEvidence,
    providerBaseUrls: sanitizeBaseUrlOverrides(unwrapped.providerBaseUrls),
    customProviders: loadCustomProviders(unwrapped.customProviders),
    outboundAuthorizations: Array.isArray(unwrapped.outboundAuthorizations) ? unwrapped.outboundAuthorizations : [],
  };

  let current = () => configured;
  let scope: { update: (patch: object) => Promise<void>; get?: () => unknown } | undefined;
  let service: any;
  let mounted = false;
  const mountedCbs: Array<() => void> = [];

  ctx.inject(["settings"], (sctx: any) => {
    service = sctx.settings;
    if (typeof service?.register === "function") {
      const registered = service.register(SETTINGS_NS, Config, {
        base: configured,
      });
      scope = registered;
      current = () => registered.get() as WebToolsSettings;
    } else {
      if (typeof service?.configure === "function") {
        try {
          ctx.effect?.(() => service.configure({ auto: false }, (ctx as any).fiber));
        } catch {}
      }
    }
    mounted = true;
    for (const cb of mountedCbs.splice(0)) cb();
  });

  return {
    read: () => current(),
    write: async (patch) => {
      if (!scope && !service) {
        throw new Error("dsh-web-tools settings namespace is not mounted");
      }
      const normalized: Partial<WebToolsSettings> = { ...patch };
      const validated = validateWebToolsSettings(patch);
      if (patch.fetchOrder !== undefined) {
        normalized.fetchOrder = validated.fetchOrder;
      }
      if (patch.smartSearch !== undefined) {
        normalized.smartSearch = validated.smartSearch;
      }
      if (patch.exemptWhenNoProvider !== undefined) {
        normalized.exemptWhenNoProvider = validated.exemptWhenNoProvider;
      }
      if (patch.recognizeExternalWebTools !== undefined) {
        normalized.recognizeExternalWebTools = validated.recognizeExternalWebTools;
      }
      if (patch.requiredEvidence !== undefined) {
        normalized.requiredEvidence = validated.requiredEvidence;
      }
      if (patch.providerBaseUrls !== undefined) {
        normalized.providerBaseUrls = sanitizeBaseUrlOverrides(patch.providerBaseUrls);
      }
      if (patch.customProviders !== undefined) {
        normalized.customProviders = loadCustomProviders(patch.customProviders);
      }
      if (patch.outboundAuthorizations !== undefined) {
        normalized.outboundAuthorizations = Array.isArray(patch.outboundAuthorizations) ? patch.outboundAuthorizations : [];
      }

      if (scope) {
        await scope.update(normalized);
      } else if (typeof service?.update === "function") {
        await service.update(SETTINGS_NS, normalized);
      }
      Object.assign(configured, normalized);
    },
    onMounted: (cb) => {
      if (mounted) {
        cb();
      } else {
        mountedCbs.push(cb);
      }
    },
  };
}
