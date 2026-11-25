/**
 * kimi-code-web-search — Local filesystem persistence for standalone gateway & Kimi Code plugin.
 *
 * Manages files under `$KIMI_CODE_HOME/web-tools/` (fallback `~/.kimi-code/web-tools/`):
 *  - `config.json`: non-secret WebToolsSettings
 *  - `credentials.json`: provider API keys and custom source credentials (0600 permissions)
 *  - `mode-state.json`: global & per-session search mode + active turn research tracking
 *  - `gateway.json`: active gateway daemon discovery metadata (pid, host, port, url)
 * @module
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, validateWebToolsSettings, type WebToolsSettings } from "./config.ts";
import type { SearchMode } from "../shared/api-types.ts";
import type { TurnState } from "./search-mode-runtime.ts";
import type { WebToolsCredentialsService, WebToolsSettingsService } from "./context-types.ts";
import { readModeState, updateModeState } from "../../hooks/mode-state.mjs";

/** `$KIMI_CODE_HOME/web-tools` (default `~/.kimi-code/web-tools`). */
export function getWebToolsBaseDir(baseDirOverride?: string): string {
  const home = baseDirOverride
    ? path.join(baseDirOverride, ".kimi-code")
    : process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), ".kimi-code");
  return path.join(home, "web-tools");
}

export interface ModeSessionRecord {
  mode?: SearchMode;
  turn?: TurnState;
  pendingTools?: string[];
  updatedAt: number;
}

export interface ModeStateDocument {
  globalMode: SearchMode;
  activeSessionId?: string;
  sessions: Record<string, ModeSessionRecord>;
  updatedAt: number;
}

export interface GatewayStateDocument {
  pid: number;
  host: string;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

function isValidMode(val: unknown): val is SearchMode {
  return val === "auto" || val === "smart" || val === "required" || val === "off";
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const WIN_RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function renameWithRetrySync(from: string, to: string): void {
  const delaysMs = [10, 25, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const retryable = code === "EBUSY" || (process.platform === "win32" && code !== undefined && WIN_RETRYABLE_RENAME_CODES.has(code));
      if (retryable && attempt < delaysMs.length) {
        Atomics.wait(waitBuffer, 0, 0, delaysMs[attempt]);
        continue;
      }
      throw err;
    }
  }
}

function writeAtomicSync(filePath: string, content: string, mode?: number): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const out = fs.openSync(tmpPath, "w", mode);
  try {
    try {
      fs.writeFileSync(out, content, "utf8");
      // Durability: fsync before rename so a crash cannot leave a truncated or
      // empty file behind (rename alone only guarantees visibility).
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    renameWithRetrySync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of temp file when write or rename fails
    }
    throw err;
  }
  if (mode !== undefined) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Ignore chmod errors on platforms that do not support POSIX permissions
    }
  }
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file-level fsync
    // above already covers the truncation risk.
  }
}

/**
 * An unreadable or unparseable state file must never be silently replaced by
 * the next save: rename it aside so the original bytes stay recoverable
 * before the caller falls back to defaults.
 */
function backupCorruptFile(filePath: string): void {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // Best effort: if the rename fails the next save still proceeds, but the
    // common case (truncated JSON) preserves the original bytes.
  }
}

export class LocalStorage {
  readonly baseDir: string;
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly modeStatePath: string;
  readonly gatewayPath: string;

  constructor(baseDirOverride?: string) {
    this.baseDir = baseDirOverride ? path.resolve(baseDirOverride) : getWebToolsBaseDir();
    this.configPath = path.join(this.baseDir, "config.json");
    this.credentialsPath = path.join(this.baseDir, "credentials.json");
    this.modeStatePath = path.join(this.baseDir, "mode-state.json");
    this.gatewayPath = path.join(this.baseDir, "gateway.json");
  }

  ensureDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
  }

  private readJsonObject(filePath: string): Record<string, unknown> | null {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      // Transient/permission read errors (EBUSY, EPERM, EACCES, EMFILE) must
      // propagate untouched rather than backing up and erasing an intact file.
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        backupCorruptFile(filePath);
        return null;
      }
      throw err;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      backupCorruptFile(filePath);
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // config.json
  // -------------------------------------------------------------------------

  readConfig(): WebToolsSettings {
    const raw = this.readJsonObject(this.configPath);
    if (raw === null) {
      return validateWebToolsSettings(DEFAULT_SETTINGS);
    }
    try {
      return validateWebToolsSettings(raw);
    } catch {
      // A corrupt config must not be silently replaced by the next save;
      // preserve the original bytes, then fall back to defaults.
      backupCorruptFile(this.configPath);
      return validateWebToolsSettings(DEFAULT_SETTINGS);
    }
  }

  writeConfig(patchOrFull: Partial<WebToolsSettings>): WebToolsSettings {
    const current = this.readConfig();
    const merged = validateWebToolsSettings({ ...current, ...patchOrFull });
    writeAtomicSync(this.configPath, JSON.stringify(merged, null, 2) + "\n", 0o600);
    return merged;
  }

  // -------------------------------------------------------------------------
  // credentials.json (0600 permissions)
  // -------------------------------------------------------------------------

  readAllCredentials(): Record<string, string> {
    const parsed = this.readJsonObject(this.credentialsPath);
    if (parsed === null) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) {
        out[k] = v;
      }
    }
    return out;
  }

  writeAllCredentials(creds: Record<string, string>): void {
    writeAtomicSync(this.credentialsPath, JSON.stringify(creds, null, 2) + "\n", 0o600);
  }

  resolveCredential(ref: string): { value?: string; source?: string } | undefined {
    const all = this.readAllCredentials();
    if (typeof all[ref] === "string" && all[ref].length > 0) {
      return { value: all[ref], source: "local" };
    }
    const envVal = process.env[ref];
    if (typeof envVal === "string" && envVal.trim().length > 0) {
      return { value: envVal.trim(), source: "env" };
    }
    return undefined;
  }

  setCredential(ref: string, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.unsetCredential(ref);
      return;
    }
    const all = this.readAllCredentials();
    all[ref] = trimmed;
    this.writeAllCredentials(all);
  }

  unsetCredential(ref: string): void {
    const all = this.readAllCredentials();
    if (ref in all) {
      delete all[ref];
      this.writeAllCredentials(all);
    }
  }

  // -------------------------------------------------------------------------
  // mode-state.json
  // -------------------------------------------------------------------------

  readModeState(): ModeStateDocument {
    return readModeState(this.modeStatePath);
  }

  writeModeState(state: ModeStateDocument): void {
    updateModeState(this.modeStatePath, (doc) => {
      doc.globalMode = state.globalMode;
      doc.sessions = state.sessions;
    });
  }

  getEffectiveSessionMode(sessionId: string): SearchMode {
    const doc = this.readModeState();
    if (!sessionId || sessionId === "global" || sessionId === "default") return doc.globalMode;
    return Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId].mode ?? doc.globalMode : doc.globalMode;
  }

  setSessionMode(sessionId: string, mode: SearchMode): SearchMode {
    if (!isValidMode(mode)) throw new Error("Invalid search mode");
    updateModeState(this.modeStatePath, (doc) => {
      const id = !sessionId || sessionId === "default" ? "global" : sessionId;
      if (id === "global") doc.globalMode = mode;
      const entry = Object.hasOwn(doc.sessions, id) ? doc.sessions[id] : {};
      Object.defineProperty(doc.sessions, id, {
        value: { ...entry, mode, updatedAt: Date.now() },
        enumerable: true, writable: true, configurable: true,
      });
    });
    return mode;
  }

  getTurnState(sessionId: string): TurnState | undefined {
    const doc = this.readModeState();
    return Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId].turn : undefined;
  }

  setTurnState(sessionId: string, turn: TurnState | undefined): void {
    updateModeState(this.modeStatePath, (doc) => {
      const existing = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
      if (turn === undefined) delete existing.turn;
      else existing.turn = turn;
      Object.defineProperty(doc.sessions, sessionId, {
        value: { ...existing, updatedAt: Date.now() },
        enumerable: true, writable: true, configurable: true,
      });
    });
  }

  recordSmartDecision(sessionId: string, decision: Record<string, unknown>): void {
    const raw = typeof sessionId === "string" ? sessionId.trim() : "";
    const unsafeKey = raw === "__proto__" || raw === "constructor" || raw === "prototype";
    const id = !raw || raw === "default" || unsafeKey || raw.length > 128 ? "global" : raw;
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const MAX_EPHEMERAL_SESSIONS = 500;
    updateModeState(this.modeStatePath, (doc) => {
      const ephemeral: Array<[string, number]> = [];
      for (const [key, entry] of Object.entries(doc.sessions)) {
        if (key === id || key === "global" || typeof entry?.mode === "string") continue;
        const at = Number(entry?.updatedAt ?? 0);
        if (!Number.isFinite(at) || at < cutoff) {
          delete doc.sessions[key];
        } else {
          ephemeral.push([key, at]);
        }
      }
      if (ephemeral.length >= MAX_EPHEMERAL_SESSIONS) {
        ephemeral.sort((a, b) => a[1] - b[1]);
        const excess = ephemeral.length - MAX_EPHEMERAL_SESSIONS + 1;
        for (let i = 0; i < excess; i++) {
          delete doc.sessions[ephemeral[i][0]];
        }
      }
      const existing = Object.hasOwn(doc.sessions, id) ? doc.sessions[id] : {};
      Object.defineProperty(doc.sessions, id, {
        value: { ...existing, lastSmartDecision: decision, updatedAt: now },
        enumerable: true, writable: true, configurable: true,
      });
    });
  }

  bindToolTurn(sessionId: string, turnId?: number): number | undefined {
    const doc = this.readModeState();
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
    // A mismatched turn id is ignored, not rejected: a stale binding must never
    // turn a legitimate search into a hard error, and the gateway records the
    // completion against the session's live turn either way.
    return turnId !== undefined && turnId === entry?.turn?.turn ? turnId : entry?.turn?.turn;
  }

  completeTool(sessionId: string, kind: "web_search" | "web_fetch", succeeded: boolean, turnId?: number): void {
    if (!sessionId || sessionId === "global") return;
    updateModeState(this.modeStatePath, (doc) => {
      const existing = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
      if (!existing?.turn || (turnId !== undefined && existing.turn.turn !== turnId)) return;
      if (kind === "web_search") {
        existing.turn.webSearchCompleted = true;
        if (succeeded) existing.turn.webSearchSucceeded = true;
      } else {
        existing.turn.webFetchCompleted = true;
        if (succeeded) existing.turn.webFetchSucceeded = true;
      }
      existing.updatedAt = Date.now();
    });
  }

  clearSession(sessionId: string): void {
    updateModeState(this.modeStatePath, (doc) => { delete doc.sessions[sessionId]; });
  }

  // -------------------------------------------------------------------------
  // gateway.json
  // -------------------------------------------------------------------------

  readGatewayState(): GatewayStateDocument | null {
    if (!fs.existsSync(this.gatewayPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.gatewayPath, "utf8")) as Partial<GatewayStateDocument>;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.host === "string" &&
        typeof parsed.port === "number" &&
        typeof parsed.url === "string"
      ) {
        return {
          pid: parsed.pid,
          host: parsed.host,
          port: parsed.port,
          url: parsed.url,
          version: typeof parsed.version === "string" ? parsed.version : "0.4.0",
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  writeGatewayState(doc: GatewayStateDocument): void {
    writeAtomicSync(this.gatewayPath, JSON.stringify(doc, null, 2) + "\n", 0o600);
  }

  clearGatewayState(onlyPid?: number): void {
    if (!fs.existsSync(this.gatewayPath)) return;
    if (onlyPid !== undefined) {
      const current = this.readGatewayState();
      if (current && current.pid !== onlyPid) return;
    }
    try {
      fs.unlinkSync(this.gatewayPath);
    } catch {
      // Ignore unlink errors
    }
  }

  // -------------------------------------------------------------------------
  // Service adapters for WebToolsContext
  // -------------------------------------------------------------------------

  createSettingsService(): WebToolsSettingsService {
    let cached = this.readConfig();
    const watchers = new Set<(next: any, prev: any) => void | Promise<void>>();
    return {
      register: <T>(_ns: string, _schema: unknown, options?: { base?: Partial<T> }) => {
        if (!fs.existsSync(this.configPath) && options?.base) {
          cached = this.writeConfig(options.base as Partial<WebToolsSettings>);
        } else {
          cached = this.readConfig();
        }
        return {
          get: () => this.readConfig() as unknown as T,
          watch: (cb) => {
            watchers.add(cb);
            return () => watchers.delete(cb);
          },
          update: async (patch: object) => {
            const prev = cached;
            cached = this.writeConfig(patch as Partial<WebToolsSettings>);
            for (const cb of watchers) await cb(cached, prev);
          },
          replace: async (section: object) => {
            const prev = cached;
            cached = this.writeConfig(section as Partial<WebToolsSettings>);
            for (const cb of watchers) await cb(cached, prev);
          },
        };
      },
      describe: () => [
        {
          ns: "dsh-web-tools",
          value: this.readConfig(),
          applies: "live" as const,
          revision: 1,
        },
      ],
      update: async (_ns: string, patch: object) => {
        const prev = cached;
        cached = this.writeConfig(patch as Partial<WebToolsSettings>);
        for (const cb of watchers) await cb(cached, prev);
      },
    };
  }

  createCredentialsService(): WebToolsCredentialsService {
    return {
      resolve: async (ref: string) => this.resolveCredential(ref),
      set: async (ref: string, value: string) => {
        this.setCredential(ref, value);
      },
      unset: async (ref: string) => {
        this.unsetCredential(ref);
      },
      describe: async (refs: string[]) => {
        const out: Record<string, { configured: boolean; source?: string; writable: boolean }> = {};
        for (const ref of refs) {
          const resolved = this.resolveCredential(ref);
          out[ref] = {
            configured: Boolean(resolved?.value),
            source: resolved?.source,
            writable: true,
          };
        }
        return out;
      },
    };
  }
}
