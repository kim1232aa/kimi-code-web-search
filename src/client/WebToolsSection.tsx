/**
 * dsh-web-tools — Web Search settings page (settings.section, id "web-tools").
 *
 * Information architecture: a one-level Settings page.
 *   - header row: title + enabled switch
 *   - search order summary + "编辑" entry (in-place edit mode: drag to reorder,
 *     pick the routing policy, add/remove providers — no separate dialog)
 *   - Providers: one unified list surface (row per provider → ProviderModal)
 *   - More settings: collapsible low-frequency knobs (timeout, test search)
 *
 * Credentials are NEVER shown as plaintext: the page shows masked hints and
 * manages keys one at a time through Host add/remove endpoints; the Host
 * keeps its existing comma-joined credential string contract.
 * @module
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  StateDot,
} from "./primitives.tsx";
import {
  IconSearchOutline16,
  IconEditOutline16,
  IconSettingsOutline16,
  IconPlusOutline16,
  IconGlobeOutline14,
} from "./icons.ts";
import {
  api,
  WebToolsApiError,
  type ConfigView,
  type QuotaView,
  type TestProviderView,
  type TestSearchView,
  type ProviderView,
  type SearchRoutingPolicy,
  type VersionCheckView,
  type PlatformStatusResponse,
  type SmartClassifierProvider,
  type SmartSearchSettings,
  type SmartSearchTestView,
  type PiImportView,
} from "./api.ts";
import { arePlatformStatusesEqual, getPlatformPollIntervalMs } from "./platform-polling.ts";
import { applyRoutingResult, createReadSequencer, routingFields } from "./routing-state.ts";
import { CURRENT_VERSION } from "../shared/version.ts";
import { text, surface, state as stateColor, button as buttonColor } from "./theme.ts";
import { ProviderModal } from "./ProviderModal.tsx";
import { CustomProviderEditor } from "./CustomProviderEditor.tsx";
import { ExternalLinkIcon, PROVIDER_CAPABILITY_KEY } from "./provider-ui-meta.tsx";
import type { UiFace } from "./registration.ts";
import { PROVIDER_BRAND } from "./brand.ts";
import {
  providerStatusOf,
  testOutcomeStatus,
  quotaSummary,
  outcomeLabel,
  translateDict,
  type TFunc,
  type ProviderStatus,
} from "./logic.ts";
import { SettingsGroup, SettingsRow } from "./ui/SettingsGroup.tsx";
import { QuotaInline } from "./ui/QuotaInline.tsx";
import { SegmentedControl } from "./ui/SegmentedControl.tsx";

export type { TFunc, ProviderStatus };
export { providerStatusOf, quotaSummary, outcomeLabel };

/** Local switch (DSH primitives ship no toggle; role=switch keeps it accessible). */
export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  const { checked, onChange, label, disabled } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "1px solid " + (checked ? "transparent" : surface.border),
        background: checked ? buttonColor.primaryFill : surface.layer2,
        cursor: disabled ? "not-allowed" : "pointer",
        flex: "none",
        padding: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "background .15s ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: checked ? buttonColor.primaryText : text.tertiary,
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

interface SectionProps {
  t: TFunc;
  /** Page-language face for the independent language switch (see registration). */
  ui?: UiFace;
}

/** 6-dot grip icon for drag handle. */
function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.35, flexShrink: 0, cursor: "grab" }}>
      <circle cx="5" cy="3" r="1.5" />
      <circle cx="11" cy="3" r="1.5" />
      <circle cx="5" cy="8" r="1.5" />
      <circle cx="11" cy="8" r="1.5" />
      <circle cx="5" cy="13" r="1.5" />
      <circle cx="11" cy="13" r="1.5" />
    </svg>
  );
}

/** One provider row inside the unified SettingsGroup list. */
function ProviderRow(props: {
  t: TFunc;
  p: ProviderView;
  quota?: QuotaView;
  testResult?: TestProviderView;
  /** Whether this provider is in the routing order (default + fallback). */
  inOrder: boolean;
  /** Show the "首选" text — only for the first entry in ordered policy. */
  showPreferred: boolean;
  isLast: boolean;
  /** In-place ordering edit mode (grip + remove), replacing the drag handle. */
  editMode?: boolean;
  isDragging?: boolean;
  isOver?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onRemove?: () => void;
  onAdd?: () => void;
  onClick: () => void;
}) {
  const {
    t, p, quota, testResult, inOrder, showPreferred, isLast,
    editMode, isDragging, isOver,
    onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, onRemove, onAdd,
    onClick,
  } = props;
  // Status: "ready" is the quiet default — only anomalies get a label.
  const base = providerStatusOf(p, quota, inOrder);
  const status = base === "ready" ? (testOutcomeStatus(testResult) ?? base) : base;
  const statusText = status === "ready" ? "" : {
    "rate-limited": t("rateLimited"),
    "auth-error": t("authError"),
    "unreachable": t("unreachable"),
    "not-configured": t("notConfigured"),
    "disabled": t("disabled"),
    "not-in-order": t("notInOrder"),
  }[status];
  const dotState: "warning" | "error" | "none" =
    status === "rate-limited" || status === "unreachable" ? "warning" : status === "auth-error" ? "error" : "none";
  const statusColor = status === "auth-error" ? stateColor.danger : status === "rate-limited" || status === "unreachable" ? stateColor.warning : text.tertiary;

  const brandIcon = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {editMode && (
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title={t("editOrder")}
          style={{ display: "inline-flex", alignItems: "center", padding: "2px 0", cursor: "grab" }}
        >
          <GripIcon />
        </span>
      )}
      {PROVIDER_BRAND[p.name] ? (
        <img src={PROVIDER_BRAND[p.name].icon} alt="" width={22} height={22} style={{ borderRadius: 5, flex: "none" }} />
      ) : (
        <div style={{ width: 22, height: 22, borderRadius: 5, background: surface.layer2, border: `1px solid ${surface.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <IconGlobeOutline14 size={14} />
        </div>
      )}
    </div>
  );

  // In edit mode the chain control IS the affordance. Showing the
  // "not in search order" label next to the "add to search order" button is
  // redundant, reads as a second (dead) control, and — because it is a rigid
  // 220px block — used to push the real button out of the card's clipped area.
  // Genuine anomalies (auth/rate-limit/unreachable) keep their label.
  const showStatusText = status !== "ready" && !(editMode === true && status === "not-in-order");

  const trailing = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12, minWidth: 0 }}>
      {editMode === true ? (
        showStatusText ? (
          <div style={{ minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
            {dotState !== "none" && <StateDot state={dotState} size={8} />}
            <span style={{ color: statusColor, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {statusText}
            </span>
          </div>
        ) : null
      ) : status !== "ready" ? (
        <div style={{ width: 220, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
          {dotState !== "none" && <StateDot state={dotState} size={8} />}
          <span style={{ color: statusColor, fontSize: 12, whiteSpace: "nowrap" }}>
            {statusText}
          </span>
        </div>
      ) : (
        <QuotaInline quota={quota} providerName={p.name} t={t} />
      )}
      {editMode && inOrder && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          aria-label={t("removeFromChain")}
          title={t("removeFromChain")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 5,
            border: "none",
            background: stateColor.danger,
            color: "#fff",
            cursor: "pointer",
            padding: 0,
            flex: "none",
            transition: "opacity .15s ease",
            outline: "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          <svg width="10" height="2" viewBox="0 0 10 2" fill="currentColor">
            <rect width="10" height="2" rx="0.5" />
          </svg>
        </button>
      )}
      {editMode && !inOrder && (
        <Button size="sm" variant="outline" onClick={() => onAdd?.()} style={{ padding: "0 8px", height: 24, flex: "none" }}>
          {t("addToChain")}
        </Button>
      )}
    </div>
  );

  const titleWithBadge = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span>{p.label}</span>
      {p.custom && (
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 4,
            background: surface.layer2,
            border: `1px solid ${surface.border}`,
            color: text.secondary,
            lineHeight: "14px",
          }}
        >
          {t("customProviderTag")}
        </span>
      )}
      {showPreferred && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: text.tertiary,
            lineHeight: "16px",
          }}
        >
          {t("preferredProviderLabel")}
        </span>
      )}
    </div>
  );

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        background: isOver ? surface.hover : isDragging ? surface.layer2 : undefined,
        opacity: isDragging ? 0.4 : 1,
        transition: "background .12s ease",
      }}
    >
      <SettingsRow
        className="wt-provider-row"
        trailingClassName="wt-provider-meta"
        icon={brandIcon}
        title={titleWithBadge}
        subtitle={p.custom ? (p.description || t("customProviderTag")) : t(PROVIDER_CAPABILITY_KEY[p.name] ?? "capability.search")}
        trailing={trailing}
        chevron={!editMode}
        isLast={isLast}
        insetDivider
        onClick={!editMode ? onClick : undefined}
      />
    </div>
  );
}

function accentText(): string {
  return "var(--dsw-alias-brand-primary)";
}

/** Test Search block: one input + real run + human-readable timeline. */
function TestSearchBlock(props: { t: TFunc; config: ConfigView; onError: (msg: string) => void }) {
  const { t, config, onError } = props;
  const [query, setQuery] = useState("DeepSeek Harness");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestSearchView | null>(null);
  const [cleared, setCleared] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setTesting(true);
    setCleared(false);
    try {
      const r = await api.testSearch(query);
      setResult(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const attempts = result?.attempts ?? [];
  const label = (name: string) => config.providers.find((p) => p.name === name)?.label ?? name;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            value={query}
            icon={<IconSearchOutline16 size={14} />}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          />
        </div>
        <Button variant="primary" size="md" onClick={() => void run()} disabled={testing || !query.trim()}>
          {testing ? t("searching") : t("search")}
        </Button>
      </div>

      {result && !cleared && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Result headline */}
          {result.ok ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: stateColor.success, fontSize: 13 }}>
              <StateDot state="done" size={8} />
              <span style={{ fontWeight: 600 }}>
                {t("usingProviderPrefix")}{label(result.backend ?? "")} · {((result.latencyMs ?? 0) / 1000).toFixed(2)} {t("secondsUnit")} · {t("resultCount", { n: result.resultCount ?? 0 })}
              </span>
              <span style={{ marginLeft: "auto" }}>
                <Button size="sm" variant="ghost" onClick={() => setCleared(true)}>{t("clearResult")}</Button>
              </span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: stateColor.danger, fontSize: 13 }}>
              <StateDot state="error" size={8} />
              <span style={{ fontWeight: 600 }}>{result.error?.message ?? t("unknownOutcome")}</span>
              <span style={{ marginLeft: "auto" }}>
                <Button size="sm" variant="ghost" onClick={() => setCleared(true)}>{t("clearResult")}</Button>
              </span>
            </div>
          )}

          {/* Human-readable attempts timeline */}
          {attempts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: text.secondary }}>
              {attempts.map((a, i) => {
                const ok = a.outcome === "success";
                const skipped = a.outcome.startsWith("skipped-");
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 14, color: text.tertiary }}>{i + 1}.</span>
                    <span style={{ color: text.primary, fontWeight: 500, minWidth: 60 }}>{label(a.provider)}</span>
                    <span style={{ color: ok ? stateColor.success : skipped ? text.tertiary : stateColor.danger, minWidth: 70 }}>
                      {outcomeLabel(t, a.outcome)}
                    </span>
                    {a.latencyMs !== undefined && (
                      <span style={{ color: text.tertiary, marginLeft: "auto" }}>
                        {(a.latencyMs / 1000).toFixed(1)} {t("secondsUnit")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Result links */}
          {result.ok && (result.results ?? []).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(result.results ?? []).slice(0, 5).map((r, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 6, borderTop: `1px solid ${surface.border}` }}>
                  <a href={r.url} target="_blank" rel="noreferrer" style={{ color: accentText(), textDecoration: "none", fontSize: 13 }}>
                    {r.title}
                  </a>
                  <span style={{ color: text.tertiary, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.snippet}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SmartSearchSettingsBlock(props: {
  t: TFunc;
  config: ConfigView;
  onChanged: () => Promise<void>;
}) {
  const { t, config, onChanged } = props;
  const settings = config.smartSearch;
  const [provider, setProvider] = useState<SmartClassifierProvider>(settings?.provider ?? "typesafe");
  const [model, setModel] = useState(settings?.model ?? "jev-latest");
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? "");
  const [threshold, setThreshold] = useState(String(settings?.threshold ?? 0.5));
  const [timeoutMs, setTimeoutMs] = useState(String(settings?.timeoutMs ?? 1500));
  const [keyDraft, setKeyDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<SmartSearchTestView | null>(null);
  const busyRef = useRef(false);
  const testingRef = useRef(false);
  const fieldId = useId();
  const thresholdId = `${fieldId}-threshold`;
  const thresholdHintId = `${thresholdId}-hint`;
  const timeoutId = `${fieldId}-timeout`;
  const timeoutHintId = `${timeoutId}-hint`;

  useEffect(() => {
    setProvider(settings?.provider ?? "typesafe");
    setModel(settings?.model ?? "jev-latest");
    setBaseUrl(settings?.baseUrl ?? "");
    setThreshold(String(settings?.threshold ?? 0.5));
    setTimeoutMs(String(settings?.timeoutMs ?? 1500));
  }, [settings?.provider, settings?.model, settings?.baseUrl, settings?.threshold, settings?.timeoutMs]);

  const effective: SmartSearchSettings = {
    enabled: settings?.enabled ?? true,
    provider: settings?.provider ?? "typesafe",
    model: settings?.model ?? "jev-latest",
    baseUrl: settings?.baseUrl ?? "",
    threshold: settings?.threshold ?? 0.5,
    timeoutMs: settings?.timeoutMs ?? 1500,
    failOpen: settings?.failOpen ?? true,
    enableTranscriptContext: settings?.enableTranscriptContext ?? true,
  };
  const credentialProvider = provider === "typesafe" ? "smart-typesafe" : provider === "openrouter" ? "smart-openrouter" : "smart-classifier";
  const providerChanged = provider !== effective.provider;
  const locked = busy || testing;
  const dirty = providerChanged || model !== effective.model || baseUrl !== effective.baseUrl || threshold !== String(effective.threshold) || timeoutMs !== String(effective.timeoutMs);

  const persist = async (patch: Record<string, unknown>) => {
    if (busyRef.current || testingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.configSave(patch);
      await onChanged();
      setResult(null);
      setSaved(true);
    } catch {
      setError(t("prefsSaveFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const draftSettings = (): SmartSearchSettings | null => {
    const value = baseUrl.trim();
    if (value) {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        setError(t("smartSearchBaseUrlInvalid"));
        return null;
      }
    }
    const nextThreshold = Number(threshold);
    const nextTimeout = Number(timeoutMs);
    if (!model.trim() || !threshold.trim() || !timeoutMs.trim() || !Number.isFinite(nextThreshold) || nextThreshold < 0.1 || nextThreshold > 0.99 || !Number.isInteger(nextTimeout) || nextTimeout < 300 || nextTimeout > 10000) {
      setError(t("smartSearchInvalidSettings"));
      return null;
    }
    return { ...effective, provider, model: model.trim(), baseUrl: value, threshold: nextThreshold, timeoutMs: nextTimeout };
  };

  const saveSettings = () => {
    const next = draftSettings();
    if (next) void persist({ smartSearch: next });
  };

  const saveKey = async (clear: boolean) => {
    if (busyRef.current || testingRef.current || providerChanged || (!clear && !keyDraft.trim())) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.credentialsSet(credentialProvider, clear ? "" : keyDraft.trim());
      setKeyDraft("");
      setResult(null);
      await onChanged();
      setSaved(true);
    } catch {
      setError(t("smartSearchKeySaveFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (testingRef.current || busyRef.current || !prompt.trim()) return;
    const next = draftSettings();
    if (!next) return;
    testingRef.current = true;
    setTesting(true);
    setError("");
    setSaved(false);
    setResult(null);
    try {
      setResult(await api.smartClassifierTest({
        prompt: prompt.trim(),
        sessionId: sessionId.trim() || undefined,
        provider: next.provider,
        model: next.model,
        baseUrl: next.baseUrl,
        timeoutMs: next.timeoutMs,
        threshold: next.threshold,
      }));
    } catch {
      setError(t("smartSearchTestFailed"));
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const fieldStyle = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, fontSize: 13, color: text.primary } as const;
  const nativeInputStyle = { width: "100%", minHeight: 34, boxSizing: "border-box", padding: "6px 10px", borderRadius: 8, border: `1px solid ${surface.border}`, background: surface.layer2, color: text.primary, font: "inherit" } as const;
  const probability = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
  const configured = config.smartSearchConfigured === true;

  return (
    <section className="wt-smart-settings">
      <style>{`
        .wt-smart-settings input:focus-visible,
        .wt-smart-settings select:focus-visible,
        .wt-smart-settings button:focus-visible {
          outline: 2px solid var(--dsw-alias-state-business-primary);
          outline-offset: 2px;
        }
      `}</style>
      <SettingsGroup title={<h3 style={{ margin: 0, font: "inherit" }}>{t("smartSearchTitle")}</h3>} dividers="full">
        <SettingsRow
          title={t("smartSearchEnabled")}
          subtitle={t("smartSearchEnabledHint")}
          trailing={<Switch checked={effective.enabled} disabled={locked} label={t("smartSearchEnabled")} onChange={(enabled) => void persist({ smartSearch: { ...effective, enabled } })} />}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "14px" }}>
          <label style={fieldStyle}>
            <span>{t("smartSearchProvider")}</span>
            <select
              name="smart-provider"
              value={provider}
              disabled={locked}
              onChange={(event) => {
                const next = event.target.value;
                if (next !== "typesafe" && next !== "openrouter" && next !== "openai-compatible") return;
                setProvider(next);
                if (next === effective.provider) {
                  setModel(effective.model);
                  setBaseUrl(effective.baseUrl ?? "");
                } else {
                  setModel(next === "typesafe" ? "jev-latest" : next === "openrouter" ? "typesafe/jev-1.14" : "");
                  setBaseUrl("");
                }
                setKeyDraft("");
                setResult(null);
                setSaved(false);
              }}
              style={nativeInputStyle}
            >
              <option value="typesafe">{t("smartSearchProviderTypesafe")}</option>
              <option value="openrouter">{t("smartSearchProviderOpenRouter")}</option>
              <option value="openai-compatible">{t("smartSearchProviderCompatible")}</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span>{t("smartSearchModel")}</span>
            <Input value={model} disabled={locked} placeholder={t("smartSearchModelPlaceholder")} onChange={(event) => { setModel(event.target.value); setSaved(false); }} />
          </label>
          <label style={fieldStyle}>
            <span>{t("smartSearchBaseUrl")}</span>
            <span style={{ fontSize: 12, color: text.tertiary, lineHeight: 1.5 }}>{t("smartSearchBaseUrlHint")}</span>
            <Input value={baseUrl} disabled={locked} type="url" placeholder={t("baseUrlPlaceholder")} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false); }} />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <div style={{ ...fieldStyle, flex: "1 1 180px" }}>
              <label htmlFor={thresholdId}>{t("smartSearchThreshold")}</label>
              <span id={thresholdHintId} style={{ fontSize: 12, color: text.tertiary }}>{t("smartSearchThresholdHint")}</span>
              <input id={thresholdId} name="smart-threshold" type="number" min={0.1} max={0.99} step={0.01} value={threshold} disabled={locked} aria-describedby={thresholdHintId} onChange={(event) => { setThreshold(event.target.value); setSaved(false); }} style={nativeInputStyle} />
            </div>
            <div style={{ ...fieldStyle, flex: "1 1 180px" }}>
              <label htmlFor={timeoutId}>{t("smartSearchTimeout")}</label>
              <span id={timeoutHintId} style={{ fontSize: 12, color: text.tertiary }}>{t("smartSearchTimeoutHint")}</span>
              <input id={timeoutId} name="smart-timeout" type="number" min={300} max={10000} step={1} value={timeoutMs} disabled={locked} aria-describedby={timeoutHintId} onChange={(event) => { setTimeoutMs(event.target.value); setSaved(false); }} style={nativeInputStyle} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <Button size="sm" variant="outline" disabled={locked || !dirty} onClick={saveSettings}>{busy ? t("saving") : t("smartSearchSaveSettings")}</Button>
            {dirty && <span style={{ fontSize: 12, color: text.tertiary }}>{t("unsavedBadge")}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: `1px solid ${surface.border}` }}>
            <label style={fieldStyle}>
              <span>{t("smartSearchKey")}</span>
              <span style={{ fontSize: 12, color: text.tertiary, lineHeight: 1.5 }}>{providerChanged ? t("smartSearchSaveProviderFirst") : t("smartSearchKeyHint")}</span>
              <Input type="password" value={keyDraft} disabled={locked || providerChanged} placeholder={t("smartSearchKeyPlaceholder")} onChange={(event) => { setKeyDraft(event.target.value); setSaved(false); }} />
            </label>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <Button size="sm" variant="outline" disabled={locked || providerChanged || !keyDraft.trim()} onClick={() => void saveKey(false)}>{t("smartSearchSaveKey")}</Button>
              <Button size="sm" variant="ghost" disabled={locked || providerChanged || !configured} onClick={() => void saveKey(true)}>{t("smartSearchClearKey")}</Button>
              {!providerChanged && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: text.secondary }}>
                  <StateDot state={configured ? "done" : "idle"} size={6} />
                  {configured ? t("connectionConfigured") : t("notConfigured")}
                  {configured && config.smartSearchKeyHint && <code>{config.smartSearchKeyHint}</code>}
                </span>
              )}
            </div>
          </div>
        </div>
        <SettingsRow
          title={t("smartSearchTranscriptContext")}
          subtitle={t("smartSearchTranscriptContextHint")}
          trailing={<Switch checked={effective.enableTranscriptContext} disabled={locked} label={t("smartSearchTranscriptContext")} onChange={(enableTranscriptContext) => void persist({ smartSearch: { ...effective, enableTranscriptContext } })} />}
        />
        <SettingsRow
          title={t("smartSearchExemptNoProvider")}
          subtitle={t("smartSearchExemptNoProviderHint")}
          trailing={<Switch checked={config.exemptWhenNoProvider ?? true} disabled={locked} label={t("smartSearchExemptNoProvider")} onChange={(exemptWhenNoProvider) => void persist({ exemptWhenNoProvider })} />}
        />
        <SettingsRow
          title={t("smartSearchExternalTools")}
          subtitle={t("smartSearchExternalToolsHint")}
          trailing={<Switch checked={config.recognizeExternalWebTools ?? true} disabled={locked} label={t("smartSearchExternalTools")} onChange={(recognizeExternalWebTools) => void persist({ recognizeExternalWebTools })} />}
        />
        <SettingsRow
          title={t("requiredEvidenceSearchOnly")}
          subtitle={t("requiredEvidenceSearchOnlyHint")}
          trailing={<Switch checked={(config.requiredEvidence ?? "search") === "search"} disabled={locked} label={t("requiredEvidenceSearchOnly")} onChange={(searchOnly) => void persist({ requiredEvidence: searchOnly ? "search" : "search-or-fetch" })} />}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px" }}>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: text.primary }}>{t("smartSearchTestTitle")}</h4>
          <p style={{ margin: 0, fontSize: 12, color: text.tertiary, lineHeight: 1.5 }}>{t("smartSearchTestHint")}</p>
          <label style={fieldStyle}>
            <span>{t("smartSearchTestPrompt")}</span>
            <Input value={prompt} disabled={locked} placeholder={t("smartSearchTestPlaceholder")} onChange={(event) => { setPrompt(event.target.value); setResult(null); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void runTest(); } }} />
          </label>
          <label style={fieldStyle}>
            <span>{t("smartSearchTestSession")}</span>
            <Input value={sessionId} disabled={locked} placeholder={t("smartSearchTestSessionPlaceholder")} onChange={(event) => { setSessionId(event.target.value); setResult(null); }} />
          </label>
          <div>
            <Button size="sm" variant="primary" disabled={locked || !prompt.trim()} onClick={() => void runTest()}>{testing ? t("smartSearchTesting") : t("smartSearchTestRun")}</Button>
          </div>
          <div role="status" aria-atomic="true" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, overflowWrap: "anywhere" }}>
            {error && <span style={{ color: stateColor.danger }}>{error}</span>}
            {saved && !error && <span style={{ color: text.secondary }}>{t("saved")}</span>}
            {result && (
              <>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, color: text.primary }}>
                  <StateDot state={!result.ok || result.fallbackReason ? "warning" : "done"} size={8} />
                  <strong>{t("smartSearchVerdict")}: {t(!result.ok || result.fallbackReason ? "smartSearchVerdictFailOpen" : result.escalated ? "smartSearchVerdictRequired" : "smartSearchVerdictOptional")}</strong>
                  <span style={{ color: text.tertiary, fontSize: 12 }}>{t("smartSearchLatency", { ms: Math.round(result.latencyMs) })}</span>
                </div>
                <div style={{ color: text.tertiary, fontSize: 12 }}>{result.provider} · {result.model}</div>
                {(result.error || result.fallbackReason) && (
                  <div style={{ color: stateColor.warning, fontSize: 12 }}>{result.error || result.fallbackReason}</div>
                )}
                <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "6px 12px", margin: 0, color: text.secondary, fontSize: 12 }}>
                  <dt>{t("smartSearchLookupProbability")} <code>(needs_external_lookup)</code></dt>
                  <dd style={{ margin: 0 }}>{probability(result.probabilities?.needs_external_lookup)}</dd>
                  <dt>{t("smartSearchClaimProbability")} <code>(involves_tool_or_config_claim)</code></dt>
                  <dd style={{ margin: 0 }}>{probability(result.probabilities?.involves_tool_or_config_claim)}</dd>
                </dl>
              </>
            )}
          </div>
        </div>
      </SettingsGroup>
    </section>
  );
}

function PiImportSection(props: { t: TFunc; onChanged: () => Promise<void> }) {
  const { t, onChanged } = props;
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<PiImportView | null>(null);
  const [error, setError] = useState("");
  const runningRef = useRef(false);

  const runImport = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setImporting(true);
    setError("");
    setSummary(null);
    try {
      const res = await api.importPi();
      setSummary(res);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("piImportFailed"));
    } finally {
      runningRef.current = false;
      setImporting(false);
    }
  };

  const hasImported = Boolean(
    summary &&
      (summary.importedSearchProviders.length > 0 ||
        summary.importedSmartProviders.length > 0 ||
        summary.importedBaseUrls.length > 0 ||
        summary.importedMode ||
        summary.importedRouting ||
        (summary.importedFetchOrder?.length ?? 0) > 0),
  );

  return (
    <section>
      <SettingsGroup>
        <SettingsRow
          title={t("piImportTitle")}
          subtitle={t("piImportHint")}
          trailing={
            <Button size="sm" variant="outline" disabled={importing} onClick={() => void runImport()}>
              {importing ? t("piImporting") : t("piImportButton")}
            </Button>
          }
          isLast={!summary && !error}
        />
        {(summary || error) && (
          <div role="status" aria-atomic="true" style={{ padding: "10px 14px", fontSize: 12, color: error ? stateColor.danger : text.secondary }}>
            {error
              ? error
              : !hasImported && summary?.skipped.length === 0
                ? t("piImportEmpty")
                : (
                  <>
                    <div>
                      {t("piImportDone", {
                        search: summary?.importedSearchProviders.join(", ") || "—",
                        smart: summary?.importedSmartProviders.join(", ") || "—",
                        mode: summary?.importedMode ?? "—",
                        skipped: summary?.skipped.length ?? 0,
                      })}
                    </div>
                    {(summary?.importedFetchOrder?.length ?? 0) > 0 && (
                      <div style={{ marginTop: 4, color: text.tertiary }}>
                        {t("piImportFetchOrder", { fetchOrder: summary!.importedFetchOrder!.join(" → ") })}
                      </div>
                    )}
                  </>
                )}
          </div>
        )}
      </SettingsGroup>
    </section>
  );
}

const SUPPORTED_FETCH_INPUT_SET = new Set(["http", "builtin-http", "exa", "tavily", "firecrawl", "parallel", "jina", "you"]);

function FetchOrderBlock(props: { t: TFunc; config: ConfigView; onSaved: () => Promise<void> }) {
  const { t, config, onSaved } = props;
  const [draft, setDraft] = useState((config.fetchOrder ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    setDraft((config.fetchOrder ?? []).join(", "));
  }, [config.fetchOrder?.join(",")]);

  const applyOrder = async (items: string[]) => {
    setSaving(true);
    setErr("");
    setSavedOk(false);
    try {
      await api.configSave({ fetchOrder: items });
      await onSaved();
      setSavedOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const commitDraft = () => {
    const tokens = draft
      .split(/[,\s→>]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const invalid = tokens.find((tok) => !SUPPORTED_FETCH_INPUT_SET.has(tok));
    if (invalid) {
      setErr(t("fetchOrderInvalid"));
      setSavedOk(false);
      return;
    }
    const deduped: string[] = [];
    for (const tok of tokens) {
      const normalized = tok === "builtin-http" ? "http" : tok;
      if (!deduped.includes(normalized)) deduped.push(normalized);
    }
    void applyOrder(deduped);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 10, borderTop: `1px solid ${surface.border}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: text.primary }}>{t("fetchOrderTitle")}</span>
        <span style={{ fontSize: 12, color: text.tertiary, lineHeight: 1.5 }}>{t("fetchOrderHint")}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Input
            value={draft}
            disabled={saving}
            placeholder={t("fetchOrderPlaceholder")}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr("");
              setSavedOk(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
          />
        </div>
        <Button size="sm" variant="outline" disabled={saving} onClick={commitDraft}>
          {saving ? t("saving") : t("fetchOrderSave")}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void applyOrder(["exa", "http", "firecrawl", "jina"])}>
          {t("fetchOrderPreset")}
        </Button>
        {(config.fetchOrder?.length ?? 0) > 0 && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void applyOrder([])}>
            {t("fetchOrderReset")}
          </Button>
        )}
        {err && <span style={{ fontSize: 12, color: stateColor.danger }}>{err}</span>}
        {savedOk && !err && <span style={{ fontSize: 12, color: text.secondary }}>{t("saved")}</span>}
      </div>
    </div>
  );
}

/** The page. */
export function WebToolsSection(props: SectionProps) {
  const { t: baseT, ui } = props;
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [dshActive, setDshActive] = useState<string>(() => ui?.getActiveLocale() ?? "zh");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Follow DSH-wide locale switches directly — the page always mirrors DSH.
  useEffect(() => {
    if (!ui) return;
    return ui.subscribeLocale(() => setDshActive(ui.getActiveLocale()));
  }, [ui]);
  const effectiveLang = dshActive === "en" ? "en" : "zh";
  const t: TFunc = useMemo(() => {
    if (!ui) return baseT;
    const dict = effectiveLang === "en" ? ui.enDict : ui.zhDict;
    const fallback = effectiveLang === "en" ? ui.zhDict : ui.enDict;
    return (key: string, ...args: unknown[]) => {
      const params = args[0] as Record<string, unknown> | undefined;
      return translateDict(dict, fallback, key, params) ?? baseT(key, ...args);
    };
  }, [ui, effectiveLang, baseT]);
  const [quotas, setQuotas] = useState<Record<string, QuotaView> | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionCheckView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const [customEditProvider, setCustomEditProvider] = useState<ProviderView | undefined>(undefined);
  const [editingOrder, setEditingOrder] = useState(false);
  const [providerTestResults, setProviderTestResults] = useState<Record<string, TestProviderView>>({});
  const [busyProviders, setBusyProviders] = useState<Record<string, boolean>>({});
  const [timeoutDraftSec, setTimeoutDraftSec] = useState<string>("");
  const dragProvider = useRef<string | null>(null);
  const [overProvider, setOverProvider] = useState<string | null>(null);
  const readSeq = useRef(createReadSequencer());
  const mounted = useRef(true);
  /** Mirror of the latest rendered config, for handlers that must not read a stale closure. */
  const configRef = useRef<ConfigView | null>(null);
  configRef.current = config;
  /** Monotonic id of the newest routing edit, so only the last intent settles the view. */
  const orderWriteSeq = useRef(0);
  /** Newest routing intent not yet confirmed by the Host (see saveOrder). */
  const pendingOrder = useRef<import("./routing-state.ts").RoutingWriteResult | null>(null);
  /** Whether a routing write is currently in flight. */
  const orderWriteInFlight = useRef(false);
  /** True while a routing edit is being persisted in the background. */
  const [savingOrder, setSavingOrder] = useState(false);

  useEffect(() => {
    if (config?.providerAttemptTimeoutMs !== undefined) {
      setTimeoutDraftSec(String(Math.round(config.providerAttemptTimeoutMs / 1000)));
    }
  }, [config?.providerAttemptTimeoutMs]);

  const [platformState, setPlatformState] = useState<PlatformStatusResponse | null>(null);
  const platformStateRef = useRef<PlatformStatusResponse | null>(null);
  platformStateRef.current = platformState;
  const isFetchingPlatform = useRef(false);

  const loadPlatformStatus = async () => {
    if (isFetchingPlatform.current) return;
    isFetchingPlatform.current = true;
    try {
      const p = await api.platformStatus();
      if (mounted.current && !arePlatformStatusesEqual(platformStateRef.current, p)) {
        setPlatformState(p);
      }
    } catch {
      // Non-blocking
    } finally {
      isFetchingPlatform.current = false;
    }
  };

  const load = async () => {
    const seq = readSeq.current.begin();
    try {
      const cfg = await api.configGet();
      if (!mounted.current) return;
      // Apply unless a NEWER read has already landed. Discarding merely because
      // a newer read STARTED silently loses the update and leaves the card
      // stale until it is reopened.
      if (!readSeq.current.accept(seq)) return;
      // Keep an un-confirmed routing edit on top: the write takes seconds, and
      // a read landing inside that window would otherwise repaint the old order.
      setConfig(pendingOrder.current ? applyRoutingResult(cfg, pendingOrder.current) : cfg);
      setError("");
    } catch (e) {
      if (mounted.current && readSeq.current.accept(seq)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    await loadPlatformStatus();
  };

  const loadQuotas = async (force = false) => {
    try {
      const quota = await api.quotaDescribe(force);
      if (!mounted.current) return;
      setQuotas(quota.quotas);
    } catch {
      // display-only; never disturb the page
    }
  };

  useEffect(() => {
    // Re-arm on every mount: the cleanup below clears this flag, and React
    // StrictMode double-invokes effects (mount → cleanup → mount), which would
    // otherwise leave it permanently false and silently disable platform
    // status + quota updates.
    mounted.current = true;
    void load();
    void loadQuotas();
    void api.versionCheck().then(setVersionInfo).catch(() => {});

    let timer: NodeJS.Timeout | undefined;
    const scheduleNextPoll = () => {
      if (!mounted.current) return;
      const isVisible = typeof document === "undefined" || document.visibilityState === "visible";
      const interval = getPlatformPollIntervalMs(isVisible, platformStateRef.current);
      if (interval > 0) {
        timer = setTimeout(async () => {
          await loadPlatformStatus();
          scheduleNextPoll();
        }, interval);
      }
    };

    scheduleNextPoll();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadPlatformStatus();
        if (timer) clearTimeout(timer);
        scheduleNextPoll();
      } else {
        if (timer) clearTimeout(timer);
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      mounted.current = false;
    };
  }, []);

  if (!config) {
    return (
      <div style={{ padding: "12px 0", color: text.tertiary, fontSize: 14 }}>
        {error ? `${t("webToolsError")}: ${error}` : t("loading")}
      </div>
    );
  }

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await api.configSave(patch);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = (enabled: boolean) => void save({ enabled });

  // Dedicated Browser Profile Login
  const loginPlatform = async (platform: "xiaohongshu" | "x") => {
    try {
      await api.platformLogin(platform);
      await loadPlatformStatus();
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resetPlatformSession = async (platform: "xiaohongshu" | "x") => {
    try {
      await api.platformReset(platform);
      await loadPlatformStatus();
    } catch (err: any) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleProvider = (name: string, enabled: boolean) => {
    const providerEnabled = Object.fromEntries(config.providers.map((p) => [p.name, p.name === name ? enabled : p.enabled]));
    void save({ providerEnabled });
  };
  const togglePlatform = (name: "xiaohongshu" | "x", enabled: boolean) => {
    const current = config.platformEnabled ?? { xiaohongshu: true, x: true };
    const platformEnabled = { ...current, [name]: enabled };
    void save({ platformEnabled });
  };
  const setBaseUrl = async (name: string, baseUrl: string) => {
    try {
      await api.sourceEndpointSet(name, baseUrl);
      await load();
    } catch (err: any) {
      if (err instanceof WebToolsApiError && err.code === "conflict") {
        if (window.confirm(err.message || t("confirmForeignOverride"))) {
          try {
            await api.sourceEndpointSet(name, baseUrl, true);
            await load();
          } catch (retryErr: any) {
            setError(retryErr instanceof Error ? retryErr.message : String(retryErr));
          }
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const commitTimeoutSec = (secStr: string) => {
    const num = Number(secStr);
    if (!Number.isFinite(num) || num <= 0) {
      if (config) setTimeoutDraftSec(String(Math.round(config.providerAttemptTimeoutMs / 1000)));
      return;
    }
    const ms = Math.min(60000, Math.max(1000, Math.round(num * 1000)));
    setTimeoutDraftSec(String(Math.round(ms / 1000)));
    if (!config || ms !== config.providerAttemptTimeoutMs) {
      void save({ providerAttemptTimeoutMs: ms });
    }
  };

  // One ordered list: [defaultProvider, ...fallbackOrder] — Host schema unchanged.
  const orderedProviders = [
    config.defaultProvider,
    ...config.fallbackOrder.filter((n) => n !== config.defaultProvider),
  ];
  const providerOf = (name: string) => config.providers.find((p) => p.name === name);

  /**
   * Latest routing order read from the live config, not this render's closure,
   * so rapid successive edits compose instead of overwriting each other.
   */
  const liveOrder = (): string[] => {
    const c = configRef.current;
    if (!c) return [];
    return [c.defaultProvider, ...c.fallbackOrder.filter((n) => n !== c.defaultProvider)];
  };

  /**
   * Persist a routing edit.
   *
   * The DSH settings write edits the profile patch and recomposes the profile,
   * which measures in SECONDS (routing/set ~2.4-3.9s against config/get
   * ~11-57ms). Two consequences shape this:
   *
   *  - painting only after the response makes the control feel dead, so the new
   *    order is applied locally at once and the write runs behind it, and
   *  - a read completing inside that multi-second window would otherwise
   *    repaint the OLD order and visibly undo the edit, so the un-confirmed
   *    intent is held in `pendingOrder` and re-applied over every read until the
   *    write settles.
   *
   * Writes are drained one at a time; a newer edit replaces the pending intent
   * instead of racing a second multi-second recomposition.
   */
  const saveOrder = (ordered: readonly string[], policy: SearchRoutingPolicy = config.searchRoutingPolicy ?? "ordered") => {
    const fields = routingFields(ordered, policy);
    ++orderWriteSeq.current;
    pendingOrder.current = fields;

    setConfig((prev) => applyRoutingResult(prev, fields));
    setError("");
    setSavingOrder(true);
    drainOrderWrites();
  };

  /** Send the pending routing intent, then drain again if another arrived. */
  const drainOrderWrites = () => {
    if (orderWriteInFlight.current) return; // the in-flight settle drains next
    const fields = pendingOrder.current;
    if (!fields) {
      setSavingOrder(false);
      return;
    }
    const seq = orderWriteSeq.current;
    orderWriteInFlight.current = true;

    void api
      .routingSet(fields.policy, [fields.defaultProvider, ...fields.fallbackOrder])
      .then((result) => {
        if (seq !== orderWriteSeq.current) return; // a newer intent owns the view
        pendingOrder.current = null;
        setConfig((prev) => applyRoutingResult(prev, result));
        setError("");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        if (seq !== orderWriteSeq.current) return;
        // Roll the optimistic order back to what the Host actually holds.
        pendingOrder.current = null;
        void load();
      })
      .finally(() => {
        orderWriteInFlight.current = false;
        if (pendingOrder.current) drainOrderWrites();
        else setSavingOrder(false);
      });
  };

  // Rendering order: providers are listed in the routing order (default +
  // fallback), then providers outside the chain (registry order).
  const renderedProviders = orderedProviders
    .map((name) => providerOf(name))
    .filter((x): x is ProviderView => x !== undefined)
    .concat(config.providers.filter((p) => !orderedProviders.includes(p.name)));

  const testProvider = async (provider: string) => {
    setBusyProviders((b) => ({ ...b, [provider]: true }));
    try {
      const r = await api.testProvider(provider, "OpenAI");
      setProviderTestResults((prev) => ({ ...prev, [provider]: r }));
    } catch (e) {
      setProviderTestResults((prev) => ({
        ...prev,
        [provider]: { ok: false, error: { code: "error", message: e instanceof Error ? e.message : String(e) } },
      }));
    } finally {
      setBusyProviders((b) => ({ ...b, [provider]: false }));
    }
  };

  // "首选" is only meaningful when the policy is ordered — round-robin and
  // random have no fixed first entry.
  const showPreferredFor = (name: string) =>
    (config.searchRoutingPolicy ?? "ordered") === "ordered" && name === config.defaultProvider;

  const detailProvider = detailFor !== null ? providerOf(detailFor) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720, padding: "4px 0 24px" }}>
      {/* Narrow-width responsive rules: provider rows wrap to two lines.
          The wrap is unconditional (it only engages when the row's own content
          cannot fit) because a narrow settings PANE can occur inside a wide
          viewport, where a viewport media query would never match — and the
          group card clips overflow, which would hide the chain buttons. */}
      <style>{`
        .wt-provider-row { flex-wrap: wrap; row-gap: 4px; }
        .wt-provider-meta { flex: 0 1 auto; min-width: 0; }
        @media (max-width: 640px) {
          .wt-provider-meta { flex-basis: 100%; order: 10; padding-left: 22px; }
        }
      `}</style>
      {/* Header: title + enabled switch */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px", color: text.primary }}>{t("title")}</h2>
          <p style={{ margin: "2px 0 0", fontSize: 14, lineHeight: "22px", color: text.tertiary }}>{t("tagline")}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 2, flex: "none", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Switch checked={config.enabled} onChange={setEnabled} disabled={saving} label={config.enabled ? t("enabledLabel") : t("disabledLabel")} />
        </div>
      </div>

      {error && <div style={{ color: stateColor.danger, fontSize: 13 }}>{error}</div>}

      {versionInfo?.updateAvailable && versionInfo.latestVersion && versionInfo.releaseUrl && (
        <div className="dswt-update-banner" role="status">
          <div className="dswt-update-copy">
            <strong>{t("updateAvailableTitle", { version: versionInfo.latestVersion })}</strong>
            <span>{t("updateAvailableBody", { current: versionInfo.currentVersion })}</span>
          </div>
          <a className="dswt-update-link" href={versionInfo.releaseUrl} target="_blank" rel="noreferrer">
            {t("viewUpdate")}
            <ExternalLinkIcon size={12} />
          </a>
        </div>
      )}

      {/* Proxy degraded warning: a proxy is configured but undici is missing,
          so provider calls fall back to direct fetch and may time out. */}
      {config.proxy?.configured === true && config.proxy?.degraded === true && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "10px 14px",
            borderRadius: 12,
            border: `1px solid ${stateColor.warning}`,
            background: surface.layer1,
            fontSize: 13,
            color: text.secondary,
          }}
        >
          <strong style={{ color: stateColor.warning, fontSize: 13 }}>{t("proxyDegradedTitle")}</strong>
          <span>{t("proxyDegradedBody")}</span>
        </div>
      )}

      {/* 搜索顺序 summary + Edit (in-place ordering edit mode) */}
      <section>
        <SettingsGroup>
          <SettingsRow
            icon={
              <div style={{ display: "inline-flex", alignItems: "center", color: text.secondary }}>
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <path d="M2 4h7M13 4h1M2 8h3M9 8h5M2 12h8M14 12h0" />
                  <circle cx="11" cy="4" r="1.5" />
                  <circle cx="7" cy="8" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                </svg>
              </div>
            }
            title={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>{t("routingLabel")}</span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: "2px 7px",
                    borderRadius: 4,
                    background: surface.layer2,
                    color: text.secondary,
                    border: `1px solid ${surface.border}`,
                    lineHeight: 1.2,
                  }}
                >
                  {t(`routingPolicy.${config.searchRoutingPolicy ?? "ordered"}`)}
                </span>
              </div>
            }
            subtitle={
              <span>
                {(() => {
                  const names = orderedProviders.map((name) => providerOf(name)?.label ?? name);
                  const separator = (config.searchRoutingPolicy ?? "ordered") === "random" ? (dshActive === "zh" ? "、" : ", ") : " → ";
                  if (names.length <= 3) {
                    return names.join(separator);
                  }
                  const head = names.slice(0, 3).join(separator);
                  return `${head} · +${names.length - 3}`;
                })()}
              </span>
            }
            trailing={
              <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                {/* The order repaints instantly; this only reports that the
                    (slow) profile write behind it is still in flight. */}
                {savingOrder && <span style={{ color: text.tertiary, fontSize: 12 }}>{t("saving")}</span>}
                <Button size="sm" variant={editingOrder ? "primary" : "outline"} icon={!editingOrder ? <IconEditOutline16 size={13} /> : undefined} onClick={() => setEditingOrder(!editingOrder)}>
                  {editingOrder ? t("done") : t("editOrder")}
                </Button>
              </div>
            }
            isLast
          />
        </SettingsGroup>
      </section>

      {/* Ordering edit mode: policy + in-place drag/reorder + add/remove */}
      {editingOrder && (
        <section>
          <SettingsGroup title={t("routingPolicySection")}>
            <div style={{ padding: "10px 14px" }}>
              <SegmentedControl
                style={{ display: "flex", width: "100%" }}
                options={[
                  { value: "ordered", label: t("routingPolicy.ordered") },
                  { value: "round-robin", label: t("routingPolicy.round-robin") },
                  { value: "random", label: t("routingPolicy.random") },
                ]}
                value={config.searchRoutingPolicy ?? "ordered"}
                onChange={(v) => saveOrder(liveOrder(), v as SearchRoutingPolicy)}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: text.tertiary }}>
                {t(`routingPolicyHint.${config.searchRoutingPolicy ?? "ordered"}`)}
              </div>
            </div>
          </SettingsGroup>
        </section>
      )}

      {/* 平台搜索源 (Platform Sources) */}
      <section>
        <SettingsGroup title={t("platformSourcesTitle")}>
          {/* Xiaohongshu Row */}
          <SettingsRow
            icon={
              <div style={{ width: 22, height: 22, borderRadius: 6, background: "#ff2442", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold" }}>
                红
              </div>
            }
            title={t("xiaohongshuTitle")}
            subtitle={
              (config.platformEnabled?.xiaohongshu ?? true) === false
                ? t("platformDisabled")
                : platformState?.platforms?.xiaohongshu?.authenticated
                  ? `${t("platformAccountPrefix")}${platformState.platforms.xiaohongshu.account?.name ?? t("platformConnected")}`
                  : platformState?.platforms?.xiaohongshu?.sessionEstablished
                    ? t("platformVerifying")
                    : t("platformNotLoggedIn")
            }
            trailing={
              <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                {(config.platformEnabled?.xiaohongshu ?? true) && (
                  platformState?.platforms?.xiaohongshu?.authenticated ? (
                    <>
                      <StateDot state="done" size={6} />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void resetPlatformSession("xiaohongshu")}
                      >
                        {t("clearSessionButton")}
                      </Button>
                    </>
                  ) : platformState?.platforms?.xiaohongshu?.sessionEstablished ? (
                    <StateDot state="ongoing" size={6} />
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void loginPlatform("xiaohongshu")}
                    >
                      {t("loginButton")}
                    </Button>
                  )
                )}
                <Switch
                  checked={config.platformEnabled?.xiaohongshu ?? true}
                  onChange={(v) => togglePlatform("xiaohongshu", v)}
                  label={t("xiaohongshuTitle")}
                />
              </div>
            }
          />

          {/* Twitter / X Row */}
          <SettingsRow
            icon={
              <div style={{ width: 22, height: 22, borderRadius: 6, background: "#000", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold" }}>
                𝕏
              </div>
            }
            title={t("xTitle")}
            subtitle={
              (config.platformEnabled?.x ?? true) === false
                ? t("platformDisabled")
                : platformState?.platforms?.x?.authenticated
                  ? `${t("platformAccountPrefix")}${platformState.platforms.x.account?.handle ?? t("platformConnected")}`
                  : platformState?.platforms?.x?.sessionEstablished
                    ? t("platformVerifying")
                    : t("platformNotLoggedIn")
            }
            trailing={
              <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                {(config.platformEnabled?.x ?? true) && (
                  platformState?.platforms?.x?.authenticated ? (
                    <>
                      <StateDot state="done" size={6} />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void resetPlatformSession("x")}
                      >
                        {t("clearSessionButton")}
                      </Button>
                    </>
                  ) : platformState?.platforms?.x?.sessionEstablished ? (
                    <StateDot state="ongoing" size={6} />
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void loginPlatform("x")}
                    >
                      {t("loginButton")}
                    </Button>
                  )
                )}
                <Switch
                  checked={config.platformEnabled?.x ?? true}
                  onChange={(v) => togglePlatform("x", v)}
                  label={t("xTitle")}
                />
              </div>
            }
            isLast
          />
        </SettingsGroup>
      </section>

      {/* Providers: unified group container */}
      <section>
        <SettingsGroup
          title={t("providersLabel")}
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPlusOutline16 size={13} />}
              onClick={() => {
                setCustomEditProvider(undefined);
                setCustomEditorOpen(true);
              }}
            >
              {t("addCustomProvider")}
            </Button>
          }
          dividers="inset"
        >
          {renderedProviders.map((p, idx) => {
            const testResult = providerTestResults[p.name];
            const isDragging = editingOrder && dragProvider.current === p.name;
            const isOver = editingOrder && overProvider === p.name && dragProvider.current !== null && dragProvider.current !== p.name;
            return (
              <ProviderRow
                key={p.name}
                t={t}
                p={p}
                quota={quotas?.[p.name]}
                testResult={testResult}
                inOrder={orderedProviders.includes(p.name)}
                showPreferred={showPreferredFor(p.name)}
                isLast={idx === renderedProviders.length - 1}
                editMode={editingOrder}
                isDragging={isDragging}
                isOver={isOver}
                onDragStart={(e) => {
                  dragProvider.current = p.name;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", p.name);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overProvider !== p.name) setOverProvider(p.name);
                }}
                onDragLeave={() => {
                  if (overProvider === p.name) setOverProvider(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromName = dragProvider.current;
                  dragProvider.current = null;
                  setOverProvider(null);
                  if (!fromName || fromName === p.name) return;

                  // Compute next order from the LIVE order so rapid edits compose
                  const currentOrderList = [...liveOrder()];
                  const fromIdx = currentOrderList.indexOf(fromName);
                  const toIdx = currentOrderList.indexOf(p.name);

                  if (fromIdx !== -1 && toIdx !== -1) {
                    currentOrderList.splice(fromIdx, 1);
                    currentOrderList.splice(toIdx, 0, fromName);
                    saveOrder(currentOrderList);
                  } else if (fromIdx === -1 && toIdx !== -1) {
                    currentOrderList.splice(toIdx, 0, fromName);
                    saveOrder(currentOrderList);
                  }
                }}
                onDragEnd={() => {
                  dragProvider.current = null;
                  setOverProvider(null);
                }}
                onRemove={() => {
                  const next = liveOrder().filter((n) => n !== p.name);
                  if (next.length > 0) saveOrder(next);
                }}
                onAdd={() => {
                  const current = liveOrder();
                  if (!current.includes(p.name)) saveOrder([...current, p.name]);
                }}
                onClick={() => {
                  if (p.custom) {
                    setCustomEditProvider(p);
                  } else {
                    setDetailFor(p.name);
                  }
                }}
              />
            );
          })}
        </SettingsGroup>
      </section>

      <SmartSearchSettingsBlock t={t} config={config} onChanged={load} />
      <PiImportSection t={t} onChanged={load} />

      {/* 诊断与高级设置 */}
      <section style={{ marginTop: 4 }}>
        <SettingsGroup>
          <SettingsRow
            icon={
              <div style={{ display: "inline-flex", alignItems: "center", color: text.secondary }}>
                <IconSettingsOutline16 size={16} />
              </div>
            }
            title={t("diagnosticsAndMore")}
            chevron
            isLast
            onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
          />
        </SettingsGroup>
        {diagnosticsOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8, padding: "14px", borderRadius: 12, background: surface.layer1, border: `1px solid ${surface.border}` }}>
            {/* Timeout */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: text.primary }}>{t("attemptTimeoutLabel")}</span>
                <span style={{ fontSize: 12, color: text.tertiary }}>{t("attemptTimeoutHint")}</span>
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={timeoutDraftSec}
                  onChange={(e) => setTimeoutDraftSec(e.target.value)}
                  onBlur={() => commitTimeoutSec(timeoutDraftSec)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    width: 54,
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: `1px solid ${surface.border}`,
                    background: surface.layer2,
                    color: text.primary,
                    fontFamily: "inherit",
                    fontSize: 13,
                    textAlign: "center",
                  }}
                />
                <span style={{ color: text.secondary, fontSize: 13 }}>{t("secondsUnit")}</span>
              </div>
            </div>

            {/* Fetch chain order */}
            <FetchOrderBlock t={t} config={config} onSaved={load} />

            {/* Test search */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 10, borderTop: `1px solid ${surface.border}` }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: text.primary }}>{t("testSearchTitle")}</span>
              <TestSearchBlock t={t} config={config} onError={(msg) => setError(msg)} />
            </div>

            {/* Bundle identity. The web shell serves client bundles as
                immutable, cache-busted by a revision derived from the file's
                mtime/size, so a page can keep running an older bundle. Showing
                the version compiled into THIS bundle makes that visible. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 10, borderTop: `1px solid ${surface.border}` }}>
              <span style={{ fontSize: 13, color: text.primary }}>
                {t("clientBundleLabel")}: <code style={{ fontFamily: "ui-monospace, monospace" }}>v{CURRENT_VERSION}</code>
              </span>
              <span style={{ fontSize: 12, color: text.tertiary }}>{t("clientBundleHint")}</span>
            </div>
          </div>
        )}
      </section>

      {/* Provider detail dialog */}
      {detailProvider && (
        <ProviderModal
          t={t}
          p={detailProvider}
          quota={quotas?.[detailProvider.name]}
          testResult={providerTestResults[detailProvider.name]}
          busy={!!busyProviders[detailProvider.name]}
          showPreferred={showPreferredFor(detailProvider.name)}
          inChain={orderedProviders.includes(detailProvider.name)}
          onClose={() => { setDetailFor(null); setProviderTestResults((prev) => { const next = { ...prev }; delete next[detailProvider.name]; return next; }); }}
          onToggle={(enabled) => toggleProvider(detailProvider.name, enabled)}
          onBaseUrl={(url) => setBaseUrl(detailProvider.name, url)}
          onTest={() => testProvider(detailProvider.name)}
          onRefreshQuota={() => void loadQuotas(true)}
          onConfigChanged={async () => {
            // Credentials or preferences changed: drop the stale probe so a
            // previous "no key" / auth error does not linger after the edit.
            setProviderTestResults((prev) => { const next = { ...prev }; delete next[detailProvider.name]; return next; });
            await load();
          }}
        />
      )}

      {/* Custom provider add/edit dialog */}
      {(customEditorOpen || customEditProvider) && (
        <CustomProviderEditor
          open
          onClose={() => {
            setCustomEditorOpen(false);
            setCustomEditProvider(undefined);
          }}
          provider={customEditProvider}
          onSaved={async (sourceId, addToOrder) => {
            await load();
            if (addToOrder) {
              const currentOrder = liveOrder();
              if (!currentOrder.includes(sourceId)) {
                await saveOrder([...currentOrder, sourceId]);
              }
            }
          }}
          onDeleted={async () => {
            await load();
          }}
          t={t}
        />
      )}
    </div>
  );
}
