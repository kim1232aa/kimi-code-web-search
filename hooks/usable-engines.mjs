/**
 * Which search engines can actually run a query.
 * SearXNG (and other self-hosted adapters) need an explicit instance URL;
 * the adapter default does not count. Hosted adapters need a configured key.
 * Disabled rows never count.
 */
export function usableSearchEngines(value) {
  if (Array.isArray(value?.usable)) {
    return value.usable
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => name.trim());
  }
  const providers = Array.isArray(value?.providers) ? value.providers : [];
  const names = [];
  for (const item of providers) {
    if (!item || typeof item !== "object" || item.enabled === false) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const selfHosted = name === "searxng" || item.needsBaseUrl === true;
    const configured = selfHosted ? item.baseUrlConfigured === true : item.keyConfigured === true;
    if (configured) names.push(name);
  }
  return names;
}

export function formatUsableEngines(value) {
  const names = usableSearchEngines(value && typeof value === "object" ? value : {});
  return `Usable search engines: ${names.length > 0 ? names.join(", ") : "(none)"}`;
}
