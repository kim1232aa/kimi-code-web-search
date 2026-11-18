/**
 * dsh-web-tools — search executor: account pools + deterministic fallback.
 *
 * Implements the DSH `WebSearchProvider` contract (`id`, `available()`,
 * `search(request, signal)`) registered on `ctx.web`. The seam's model-facing
 * `web_search`/`web_fetch` tools (from `dsh-tool-web`) execute through this.
 * The provider contracts are restated structurally (no dsh-web import) so the
 * plugin resolves outside the monorepo, following the better-sidebar pattern.
 * @module
 */
import { classifyFailure, fallbackChain } from "./fallback.ts";
import { resolveSearchChain, type SearchRoutingPolicy, type SearchRoutingState } from "./routing-policy.ts";
import { buildPool, markUnhealthy, markUsed, reserveKey, releaseKey, resetHealth, selectIndex, PoolEntry } from "./pool.ts";
import { PROVIDERS } from "./providers/index.ts";
import type { ProviderError, ProviderErrorCode } from "./providers/types.ts";
import { isKeylessSelfHosted } from "./providers/types.ts";
import type { StoredProviderOptions } from "../shared/provider-options.ts";
import { extractSearchHints } from "./search-hints.ts";
import type { ProviderHealthStore } from "./provider-health.ts";
import { fetchGenericWebPage, GenericFetchError } from "./generic-fetch.ts";
import type { CatalogEntry, ProviderSnapshot } from "./custom-provider-registry.ts";

/** Stable provider id registered on ctx.web (the `web` row's searchProvider). */
export const PROVIDER_ID = "dsh-web-tools";

/** Structural mirror of the seam's WebSearchProvider contract. */
export interface WebSearchProviderLike {
  id: string;
  available(): boolean;
  search(request: { query: string; maxResults?: number; provider?: string }, signal?: AbortSignal): Promise<{
    content?: string;
    sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>;
    truncated: boolean;
  }>;
}

/** Structural mirror of the seam's WebFetchProvider contract. */
export interface WebFetchProviderLike {
  id: string;
  available(): boolean;
  fetch(request: { url: string }, signal?: AbortSignal): Promise<{
    url: string;
    statusCode: number;
    body: { kind: "html" | "text"; content: string };
    truncated: boolean;
    backend?: string;
    metadata?: {
      title?: string;
      author?: string;
      publishedAt?: string;
      description?: string;
    };
  }>;
}

/** A classified failure the executor throws (WebError-compatible shape). */
export class WebToolsWebError extends Error {
  code = "WEB_PROVIDER_ERROR";
  attempts?: Array<{ provider: string; outcome: string; latencyMs?: number }>;
}

/** Runtime configuration resolved per search (snapshot per operation). */
export interface WebToolsRuntimeConfig {
  enabled: boolean;
  defaultProvider: string;
  /** Per-attempt budget for ONE provider call (the DSH tool owns the overall timeout). */
  providerAttemptTimeoutMs: number;
  fallbackOrder: string[];
  /** Optional dedicated fetch provider chain (may include `"http"` / `"builtin-http"`). */
  fetchOrder?: string[];
  /** Search routing policy — how the runtime picks the starting provider per query. */
  searchRoutingPolicy?: SearchRoutingPolicy;
  providerBaseUrls: Record<string, string>;
  enabledProviders: Record<string, boolean>;
  providerOptions?: StoredProviderOptions;
}

/** Live per-provider key pools, keyed by provider name. */
export type Pools = Record<string, PoolEntry[]>;

/** A per-provider pool with the raw credential it was built from. */
interface PoolSlot {
  raw: string;
  entries: PoolEntry[];
}

/**
 * Shared credential pool store. One instance per plugin; Search and Fetch
 * executors share it so they never fight over separate pools.
 *
 * - Rebuilds a provider's pool ONLY when its credential string changed
 *   (avoids the concurrent-search race of replacing entries out from under an
 *   in-flight request).
 * - Preserves uses/health for keys that persist across rebuilds.
 * - markUsed/markUnhealthy mutate the stable entries array in place.
 */
export function createPoolStore(resolveKeys: (providerName: string) => Promise<string>) {
  const slots = new Map<string, PoolSlot>();

  async function poolOf(providerName: string): Promise<PoolEntry[]> {
    const raw = await resolveKeys(providerName);
    const prev = slots.get(providerName);
    if (prev && prev.raw === raw) return prev.entries;

    const next = buildPool(raw);
    if (prev) {
      const byKey = new Map(prev.entries.map((e) => [e.key, e]));
      for (const e of next) {
        const old = byKey.get(e.key);
        if (old) {
          e.uses = old.uses;
          e.healthy = old.healthy;
        }
      }
    }
    slots.set(providerName, { raw, entries: next });
    return next;
  }

  /**
   * Drop one source's pool entirely.
   *
   * Used when a source is deleted or its credential/endpoint identity changes:
   * the cached entries (and any per-key health they carry) no longer describe
   * anything real. Other sources' pools are untouched.
   */
  function forget(providerName: string): void {
    slots.delete(providerName);
  }

  return { poolOf, forget };
}

export type PoolStore = ReturnType<typeof createPoolStore>;

/**
 * Backoff state for pool health self-heal, keyed by pool store so the search
 * and fetch providers sharing one store share one backoff per provider.
 */
const poolResetState = new WeakMap<PoolStore, Map<string, number>>();
const POOL_RESET_BACKOFF_MS = 60_000;

/**
 * When every key in a pool is unhealthy, reset the pool at most once per
 * backoff window: a genuinely invalid key is not retried on every request,
 * while a transient auth glitch (CDN/WAF 403 misclassified as auth) self-heals
 * within a minute instead of disabling the provider until a manual probe.
 */
export function selfHealPool(pools: PoolStore, providerName: string, entries: PoolEntry[]): boolean {
  if (entries.some((e) => e.healthy)) return false;
  let byProvider = poolResetState.get(pools);
  if (!byProvider) {
    byProvider = new Map();
    poolResetState.set(pools, byProvider);
  }
  const now = Date.now();
  const last = byProvider.get(providerName) ?? 0;
  if (now - last < POOL_RESET_BACKOFF_MS) return false;
  byProvider.set(providerName, now);
  resetHealth(entries);
  return true;
}

/** Structural subset of a provider adapter the executor needs (injectable). */
export interface ProviderAdapterLike {
  name: string;
  needsBaseUrl: boolean;
  fetchCapable: boolean;
  search(query: string, maxResults: number | undefined, apiKey: string, baseUrl: string | undefined, contextOrSignal?: AbortSignal | { signal?: AbortSignal; options?: unknown; hints?: unknown }): Promise<{ sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }> }>;
  fetch(url: string, apiKey: string, baseUrl: string | undefined, contextOrSignal?: AbortSignal | { signal?: AbortSignal; options?: unknown; hints?: unknown }): Promise<{ text: string }>;
}

/** Build a WebToolsSearchProvider for `ctx.web.registerSearchProvider`.
 *  `adapterRegistry` is injectable for tests; production uses the global
 *  PROVIDERS map (passed by index.ts via the default).
 *
 *  `resolveSnapshot` is the Issue #9 seam: when supplied, EVERY request reads
 *  one immutable catalog snapshot up front and takes adapters, credentials,
 *  endpoint overrides and keyless-ness from it. A config edit mid-flight can
 *  therefore never swap an adapter out from under the request. */
export function createSearchProvider(
  resolveConfig: () => WebToolsRuntimeConfig,
  resolveKeys: (providerName: string) => Promise<string>,
  stats: {
    record: (entry: { provider: string; outcome: string; latencyMs: number }) => void;
  },
  adapterRegistry: Record<string, ProviderAdapterLike> = PROVIDERS,
  poolStore?: PoolStore,
  healthStore?: ProviderHealthStore,
  resolveSnapshot?: () => ProviderSnapshot,
): WebSearchProviderLike {
  const pools = poolStore ?? createPoolStore(resolveKeys);
  const routingState: SearchRoutingState = { nextRoundRobinIndex: 0 };

  /**
   * Coalesce identical concurrent searches so duplicate tool calls (for example
   * two subagents asking the same question) do not double-bill providers.
   * Only overlapping calls share a promise; once it settles, the next call
   * runs a fresh search, so result freshness is unchanged. The initiating
   * caller's AbortSignal governs the shared upstream attempt.
   */
  const inflightSearches = new Map<string, ReturnType<WebSearchProviderLike["search"]>>();

  /** Adapter for one source id, preferring the live snapshot. */
  const adapterFor = (sourceId: string, snapshot?: ProviderSnapshot): ProviderAdapterLike | undefined => {
    if (snapshot) return snapshot.get(sourceId)?.adapter as ProviderAdapterLike | undefined;
    return adapterRegistry[sourceId];
  };

  /** Whether one source can run without a credential. */
  const keylessOf = (sourceId: string, adapter: ProviderAdapterLike, snapshot?: ProviderSnapshot): boolean => {
    const entry = snapshot?.get(sourceId);
    if (entry) return entry.keyless;
    return isKeylessSelfHosted(adapter);
  };

  return {
    id: PROVIDER_ID,

    /**
     * "Web Search provider service available": the plugin is enabled AND the
     * configured chain contains at least one enabled adapter. This deliberately
     * does NOT check that an API key is configured — keys are resolved lazily
     * per search and a missing key surfaces as an auth failure at call time.
     * UI copy treats this as "service available" (a chain provider exists), not
     * "a credential is ready"; per-key readiness is shown in the settings card.
     */
    available() {
      const cfg = resolveConfig();
      if (!cfg.enabled) return false;
      const snapshot = resolveSnapshot?.();
      const baseChain = fallbackChain({
        defaultProvider: cfg.defaultProvider,
        fallbackOrder: cfg.fallbackOrder,
      });
      const chain = resolveSearchChain(
        baseChain,
        cfg.searchRoutingPolicy ?? "ordered",
      );
      return chain.some((name) => {
        if (cfg.enabledProviders[name] === false) return false;
        const entry = snapshot?.get(name);
        if (entry?.config && entry.config.enabled === false) return false;
        return adapterFor(name, snapshot) !== undefined;
      });
    },

    async search(request: { query: string; maxResults?: number; provider?: string }, signal?: AbortSignal) {
      const inflightKey = `${request.provider ?? ""}\u0000${request.maxResults ?? ""}\u0000${request.query}`;
      const shared = inflightSearches.get(inflightKey);
      if (shared !== undefined) return shared;
      const pending = (async () => {
        const cfg = resolveConfig();
        if (!cfg.enabled) throw new WebToolsWebError("web search is disabled");
        // ONE snapshot for the whole request (see the doc comment above).
        const snapshot = resolveSnapshot?.();
        // maxResults is owned by the DSH tool layer (it always passes its own);
        // the plugin does not override it.
        const maxResults = request.maxResults;
        const baseChain = fallbackChain({
          defaultProvider: cfg.defaultProvider,
          fallbackOrder: cfg.fallbackOrder,
        });
        let chain = resolveSearchChain(
          baseChain,
          cfg.searchRoutingPolicy ?? "ordered",
          routingState,
        );
        const requested = typeof request.provider === "string" ? request.provider.trim().toLowerCase() : "";
        if (requested) {
          if (!adapterFor(requested, snapshot)) {
            throw new WebToolsWebError(`Unknown search provider: "${requested}"`);
          }
          if (cfg.enabledProviders[requested] === false || snapshot?.get(requested)?.config?.enabled === false) {
            throw new WebToolsWebError(`Search provider "${requested}" is disabled`);
          }
          chain = [requested, ...chain.filter((name) => name !== requested)];
        }

        const attempts: Array<{ provider: string; outcome: string; latencyMs?: number }> = [];
        let lastError: ProviderError | undefined;
        const searchHints = extractSearchHints(request.query);

        for (const providerName of chain) {
          if (cfg.enabledProviders[providerName] === false) continue;
          const entryInfo: CatalogEntry | undefined = snapshot?.get(providerName);
          if (entryInfo?.config && entryInfo.config.enabled === false) {
            attempts.push({ provider: providerName, outcome: "skipped-disabled" });
            continue;
          }
          const adapter = adapterFor(providerName, snapshot);
          if (!adapter) {
            attempts.push({ provider: providerName, outcome: "skipped-no-adapter" });
            continue;
          }
          let entries = await pools.poolOf(providerName);
          const keyless = keylessOf(providerName, adapter, snapshot);
          if (entries.length === 0 && keyless) {
            // Keyless sources (self-hosted SearXNG, or a custom source with auth
            // mode "none") execute with an empty key.
            entries = [new PoolEntry("", 0)];
          } else if (entries.length === 0) {
            attempts.push({ provider: providerName, outcome: "skipped-no-keys" });
            continue;
          }

          // Auth-invalid keys stay unhealthy until the credential actually
          // changes (refreshPool preserves healthy=false for persisted keys).
          // When the whole pool is unhealthy, self-heal with a per-provider
          // backoff (see selfHealPool) instead of skipping until a manual probe.
          let usable = entries.filter((e) => e.healthy);
          if (usable.length === 0 && selfHealPool(pools, providerName, entries)) {
            usable = entries.filter((e) => e.healthy);
          }
          if (usable.length === 0) {
            attempts.push({ provider: providerName, outcome: "skipped-no-healthy-keys" });
            continue;
          }

          // Provider-level cooldown (Retry-After). The store uses its own clock
          // (injectable for tests) — zero HTTP when cooling down.
          if (healthStore?.isCoolingDown(providerName)) {
            attempts.push({ provider: providerName, outcome: "skipped-cooldown" });
            continue;
          }

          // Provider-internal key failover: on AUTH failures only, try the next
          // healthy key in the SAME provider before falling back to another
          // provider. Non-auth failures (429/5xx/network/timeout) do not rotate
          // keys — they fall through to the next provider directly.
          let providerLevelDecision: "next-provider" | "break" | "terminal" | null = null;
          // Base URL from the request snapshot, so an override edit mid-request
          // cannot make one attempt dial a different host than another.
          const searchBaseUrl = entryInfo?.builtIn
            ? entryInfo.endpoint?.effectiveBaseUrl
            : cfg.providerBaseUrls[providerName];
          while (usable.length > 0) {
            const index = selectIndex(entries);
            const entry = entries[index];
            if (entry) reserveKey(entries, index);
            const started = Date.now();
            const providerOptions = cfg.providerOptions?.[providerName as keyof StoredProviderOptions];
            try {
              const outcome = await runWithTimeout(
                (s) =>
                  adapter.search(request.query, maxResults, entry?.key ?? "", searchBaseUrl, {
                    signal: s,
                    options: providerOptions,
                    hints: searchHints,
                  }),
                cfg.providerAttemptTimeoutMs,
                signal,
              );
              if (entry) markUsed(entries, index);
              const latencyMs = Date.now() - started;
              attempts.push({ provider: providerName, outcome: "success", latencyMs });
              stats.record({ provider: providerName, outcome: "success", latencyMs });
              return {
                ...outcome,
                truncated: false,
                attempts,
                backend: providerName,
              };
            } catch (error) {
              const err = toProviderError(error);
              const latencyMs = Date.now() - started;
              const decision = classifyFailure(err);
              // Caller cancellation terminates the whole chain — never fall back.
              if (decision === "terminal") {
                providerLevelDecision = "terminal";
                lastError = err;
                attempts.push({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                stats.record({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                break;
              }
              if (decision === "non-retryable") {
                providerLevelDecision = "break";
                lastError = err;
                attempts.push({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                stats.record({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                break;
              }
              // retryable:
              if (err.code === "auth") {
                // key indicted → mark unhealthy, try the next key in this pool
                markUnhealthy(entries, index);
                attempts.push({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                stats.record({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
                usable = entries.filter((e) => e.healthy);
                continue;
              }
              // non-auth retryable (429/5xx/network/timeout) → next provider
              lastError = err;
              // Only rate-limit errors carry a server-requested cooldown.
              if (err.code === "rate-limit" && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0) {
                healthStore?.cooldownFor(providerName, err.retryAfterMs, "rate-limit");
              }
              attempts.push({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
              stats.record({ provider: providerName, outcome: `failed:${err.code}`, latencyMs });
              providerLevelDecision = "next-provider";
              break;
            } finally {
              if (entry) releaseKey(entries, index);
            }
          }

          if (providerLevelDecision === "terminal") throw toWebError(lastError);
          if (providerLevelDecision === "break") break;
          // else fall through to the next provider in the chain
        }

        const reason = lastError
          ? `${lastError.code}: ${lastError.message}`
          : "no usable provider";
        const err = new WebToolsWebError(`web search failed after ${attempts.length} attempt(s): ${reason}`);
        err.attempts = attempts;
        throw err;
      })();
      inflightSearches.set(inflightKey, pending);
      try {
        return await pending;
      } finally {
        if (inflightSearches.get(inflightKey) === pending) inflightSearches.delete(inflightKey);
      }
    },
  };
}

/**
 * Build a `WebFetchProvider` for `ctx.web.registerFetchProvider`.
 * Routes fetch through configured native fetch providers (Tavily, Exa, Jina,
 * Firecrawl, Parallel) when available/healthy, and deterministically falls
 * back to the built-in generic HTTP fetcher (with SSRF guard + Defuddle Markdown
 * parsing) when native providers are unavailable, keyless, or fail.
 */
export function createFetchProvider(
  resolveConfig: () => WebToolsRuntimeConfig,
  resolveKeys: (providerName: string) => Promise<string>,
  adapterRegistry: Record<string, ProviderAdapterLike> = PROVIDERS,
  poolStore?: PoolStore,
  healthStore?: ProviderHealthStore,
  genericFetcher: typeof fetchGenericWebPage = fetchGenericWebPage,
  resolveSnapshot?: () => ProviderSnapshot,
): WebFetchProviderLike {
  const pools = poolStore ?? createPoolStore(resolveKeys);

  return {
    id: `${PROVIDER_ID}-fetch`,
    available() {
      const cfg = resolveConfig();
      // Built-in generic fetcher is always available as long as dsh-web-tools is enabled.
      return cfg.enabled;
    },
    async fetch(request: { url: string }, signal?: AbortSignal) {
      const cfg = resolveConfig();
      const snapshot = resolveSnapshot?.();
      const configuredFetch = Array.isArray(cfg.fetchOrder)
        ? cfg.fetchOrder
            .map((name) => (typeof name === "string" ? name.trim().toLowerCase() : ""))
            .filter(Boolean)
            .map((name) => (name === "builtin-http" ? "http" : name))
        : [];
      const baseChain = configuredFetch.length > 0
        ? configuredFetch
        : fallbackChain({
            defaultProvider: cfg.defaultProvider,
            fallbackOrder: cfg.fallbackOrder,
          }).map((name) => (name === "builtin-http" ? "http" : name));
      const steps: string[] = [];
      for (const name of baseChain) {
        if (!steps.includes(name)) steps.push(name);
      }
      // An explicit fetch order is authoritative. Built-in HTTP is appended only
      // to the legacy search-derived chain, preserving DSH's last-resort fallback.
      if (configuredFetch.length === 0 && !steps.includes("http")) steps.push("http");

      const attempts: Array<{ provider: string; outcome: string }> = [];
      let lastNativeError: ProviderError | undefined;
      let lastGenericError: WebToolsWebError | undefined;
      let lastExecutedError: Error | undefined;
      let chainTerminated = false;
      let httpAttempted = false;
      const terminalGenericCodes = new Set(["WEB_INVALID_URL", "WEB_FETCH_BLOCKED", "WEB_ABORTED"]);

      const runBuiltinHttp = async (isFinalStep: boolean) => {
        httpAttempted = true;
        if (signal?.aborted) {
          const abortErr = new WebToolsWebError("web fetch aborted by caller");
          abortErr.code = "WEB_ABORTED";
          abortErr.attempts = attempts;
          throw abortErr;
        }
        try {
          const res = await genericFetcher(request.url, {
            signal,
            timeoutMs: cfg.providerAttemptTimeoutMs,
          });
          attempts.push({ provider: "builtin-http", outcome: "success" });
          return {
            url: res.finalUrl,
            statusCode: res.statusCode,
            body: { kind: "text" as const, content: res.content },
            truncated: res.truncated,
            backend: res.backend,
            metadata: {
              title: res.title,
              author: res.author,
              publishedAt: res.publishedAt,
              description: res.description,
            },
          };
        } catch (genErr: unknown) {
          if (genErr instanceof GenericFetchError) {
            attempts.push({ provider: "builtin-http", outcome: `failed:${genErr.code}` });
            const webErr = new WebToolsWebError(`web fetch failed: ${genErr.message}`);
            webErr.code = genErr.code;
            webErr.attempts = attempts;
            lastExecutedError = webErr;
            if (isFinalStep || terminalGenericCodes.has(genErr.code)) {
              throw webErr;
            }
            lastGenericError = webErr;
            return undefined;
          }
          attempts.push({ provider: "builtin-http", outcome: "failed:network" });
          const fallbackErr = new WebToolsWebError(
            `web fetch failed: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
          );
          fallbackErr.attempts = attempts;
          lastExecutedError = fallbackErr;
          if (isFinalStep) throw fallbackErr;
          lastGenericError = fallbackErr;
          return undefined;
        }
      };

      for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
        const providerName = steps[stepIdx];
        if (providerName === "http") {
          if (cfg.enabledProviders.http === false || cfg.enabledProviders["builtin-http"] === false) continue;
          const result = await runBuiltinHttp(stepIdx === steps.length - 1);
          if (result) return result;
          continue;
        }
        if (cfg.enabledProviders[providerName] === false) continue;
        const nativeEntry = snapshot?.get(providerName);
        if (nativeEntry?.config && nativeEntry.config.enabled === false) continue;
        const adapter = (nativeEntry?.adapter as ProviderAdapterLike | undefined) ?? adapterRegistry[providerName];
        if (!adapter || !adapter.fetchCapable) continue;
        const entries = await pools.poolOf(providerName);
        if (entries.length === 0) continue;
        let usable = entries.filter((e) => e.healthy);
        if (usable.length === 0 && selfHealPool(pools, providerName, entries)) {
          usable = entries.filter((e) => e.healthy);
        }
        if (usable.length === 0) continue;
        if (healthStore?.isCoolingDown(providerName)) continue;
        const providerOptions = cfg.providerOptions?.[providerName as keyof StoredProviderOptions];
        const fetchBaseUrl = cfg.providerBaseUrls[providerName];
        // Key failover mirrors the search path: on AUTH failures try the next
        // healthy key in this provider's pool before moving down the chain.
        let index = selectIndex(entries);
        let entry = entries[index];
        if (entry) reserveKey(entries, index);
        try {
          while (entry) {
            try {
              const { text } = await runWithTimeout(
                (sig) =>
                  adapter.fetch(request.url, entry.key, fetchBaseUrl, {
                    signal: sig,
                    options: providerOptions,
                  }),
                cfg.providerAttemptTimeoutMs,
                signal,
              );
              markUsed(entries, index);
              attempts.push({ provider: providerName, outcome: "success" });
              return {
                url: request.url,
                statusCode: 200,
                body: { kind: "text" as const, content: text },
                truncated: false,
                backend: providerName,
              };
            } catch (error) {
              const err = toProviderError(error);
              const decision = classifyFailure(err);
              if (err.code !== "auth" || decision === "terminal" || decision === "non-retryable") {
                if (err.code === "auth") markUnhealthy(entries, index);
                if (err.code === "rate-limit" && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0) {
                  healthStore?.cooldownFor(providerName, err.retryAfterMs, "rate-limit");
                }
                lastNativeError = err;
                attempts.push({ provider: providerName, outcome: `failed:${err.code}` });
                const mappedErr = toWebError(error);
                mappedErr.attempts = attempts;
                lastExecutedError = mappedErr;
                if (decision === "terminal") {
                  throw mappedErr;
                }
                if (decision === "non-retryable") {
                  chainTerminated = true;
                  break;
                }
                break;
              }
              // auth retryable: rotate to the next healthy key in this pool
              markUnhealthy(entries, index);
              attempts.push({ provider: providerName, outcome: `failed:${err.code}` });
              usable = entries.filter((e) => e.healthy);
              releaseKey(entries, index);
              index = selectIndex(entries);
              entry = entries[index];
              if (entry) reserveKey(entries, index);
            }
          }
        } finally {
          if (entry) releaseKey(entries, index);
        }
        // A non-retryable native failure stops the whole chain — builtin HTTP
        // must not run after the configured providers gave a definitive no.
        if (chainTerminated) break;
      }

      if (
        configuredFetch.length === 0 &&
        !chainTerminated &&
        !httpAttempted &&
        cfg.enabledProviders.http !== false &&
        cfg.enabledProviders["builtin-http"] !== false
      ) {
        const result = await runBuiltinHttp(true);
        if (result) return result;
      }

      if (lastExecutedError) throw lastExecutedError;
      if (lastGenericError) throw lastGenericError;
      const finalErr = toWebError(lastNativeError ?? new Error("web fetch failed"));
      finalErr.attempts = attempts;
      throw finalErr;
    },
  };
}

/** Convert any thrown value into a classified ProviderError. */
function toProviderError(error: unknown): ProviderError {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as ProviderError).code === "string") {
    return error as ProviderError;
  }
  const message = error instanceof Error ? error.message : String(error);
  const err = new Error(message) as ProviderError;
  err.code = "network";
  return err;
}

/** Wrap an unknown failure from a provider call into a WebToolsWebError. */
function toWebError(error: unknown): WebToolsWebError {
  const p = toProviderError(error);
  const err = new WebToolsWebError(p.message);
  // preserve cancellation semantics: aborted stays aborted
  if (p.code === "aborted") err.code = "WEB_ABORTED";
  return err;
}

/**
 * Run a provider attempt with a real abort: the provider's fetch receives a
 * signal that fires on EITHER the caller's cancellation OR this attempt's
 * timeout, so a timeout genuinely aborts the in-flight HTTP request (no
 * background request lingering / burning quota).
 *
 * Distinguishes the two cases:
 *  - caller abort  → rejects with `aborted` (terminal; the chain stops)
 *  - attempt timeout → rejects with `timeout` (retryable; fallback proceeds)
 *
 * @param run - the provider call; receives the merged abort signal.
 * @param timeoutMs - per-attempt budget; <=0 disables the timer.
 * @param externalSignal - the caller's AbortSignal (optional).
 */
async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  // Explicit abort-cause state. A caller abort CLEARS the timer immediately,
  // so a late timer callback can never flip a caller cancellation into a
  // timeout (which would wrongly trigger fallback).
  let abortCause: "caller" | "timeout" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const onExternalAbort = () => {
    abortCause = "caller";
    clearTimer();
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) throw providerErrorOf("aborted", "search aborted by caller");
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (abortCause !== undefined) return; // already aborted by caller
      abortCause = "timeout";
      controller.abort(new Error(`provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  try {
    const value = await run(controller.signal);
    if (controller.signal.aborted) {
      throw providerErrorOf(abortCause === "timeout" ? "timeout" : "aborted", controller.signal.reason?.message ?? "attempt aborted");
    }
    return value;
  } catch (error) {
    // If OUR timer fired, the provider's own abort (whatever code it raised)
    // is a TIMEOUT — even if the adapter rethrew its own 'aborted'. External
    // cancellation is only 'aborted' when abortCause is not "timeout".
    if (controller.signal.aborted) {
      throw providerErrorOf(abortCause === "timeout" ? "timeout" : "aborted", controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason ?? "aborted"));
    }
    throw error;
  } finally {
    clearTimer();
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/** Build a classified ProviderError with a code + message. */
function providerErrorOf(code: ProviderErrorCode, message: string): ProviderError {
  const err = new Error(message) as ProviderError;
  err.code = code;
  return err;
}
