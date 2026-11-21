#!/usr/bin/env node
/**
 * kimi-code-web-search — Import Pi (`always-search.ts` & `pi-web-access`) config and API keys.
 *
 * Usage:
 *   node ./bin/import-pi.mjs [--pi-dir <path>]
 *
 * Writes directly to `$KIMI_CODE_HOME/web-tools/` (`credentials.json` 0600,
 * `config.json`, `mode-state.json`) and prints ONLY the sanitized import summary
 * (never prints plaintext API keys).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

async function loadModules() {
  const compiledStorage = path.join(PROJECT_ROOT, "lib", "host", "local-storage.js");
  const compiledImport = path.join(PROJECT_ROOT, "lib", "host", "pi-import.js");
  if (fs.existsSync(compiledStorage) && fs.existsSync(compiledImport)) {
    const { LocalStorage } = await import(pathToFileURL(compiledStorage).href);
    const { importFromPi } = await import(pathToFileURL(compiledImport).href);
    return { LocalStorage, importFromPi };
  }
  const { LocalStorage } = await import(pathToFileURL(path.join(PROJECT_ROOT, "src", "host", "local-storage.ts")).href);
  const { importFromPi } = await import(pathToFileURL(path.join(PROJECT_ROOT, "src", "host", "pi-import.ts")).href);
  return { LocalStorage, importFromPi };
}

async function main() {
  const args = process.argv.slice(2);
  let piDir;
  const idx = args.indexOf("--pi-dir");
  if (idx >= 0 && typeof args[idx + 1] === "string") {
    piDir = args[idx + 1];
  }

  const { LocalStorage, importFromPi } = await loadModules();
  const storage = new LocalStorage();
  storage.ensureDir();

  const summary = await importFromPi(
    {
      readConfig: () => storage.readConfig(),
      writeConfig: async (patch) => {
        storage.writeConfig(patch);
      },
      readCredential: async (ref) => {
        const resolved = storage.resolveCredential(ref);
        return { value: resolved?.source === "local" ? resolved.value : undefined };
      },
      writeCredential: async (ref, value) => {
        storage.setCredential(ref, value);
      },
      setGlobalMode: (mode) => {
        storage.setSessionMode("global", mode);
      },
    },
    { piDir },
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[kimi-code-web-search import-pi]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
