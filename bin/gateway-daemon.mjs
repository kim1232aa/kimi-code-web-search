#!/usr/bin/env node
/**
 * kimi-code-web-search — Gateway Daemon CLI & Lifecycle Manager.
 *
 * Usage:
 *   node ./bin/gateway-daemon.mjs              # Start in foreground (default)
 *   node ./bin/gateway-daemon.mjs --serve      # Start in foreground
 *   node ./bin/gateway-daemon.mjs --daemon     # Spawn detached background daemon & wait until healthy
 *   node ./bin/gateway-daemon.mjs ensure       # Ensure daemon is running (spawn if needed)
 *   node ./bin/gateway-daemon.mjs status       # Print gateway status JSON
 *   node ./bin/gateway-daemon.mjs stop         # Stop running daemon
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = process.env.KIMI_WEB_TOOLS_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.KIMI_WEB_TOOLS_PORT || 18492);

function getWebToolsDir() {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  const home = explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), ".kimi-code");
  return path.join(home, "web-tools");
}

function getGatewayJsonPath() {
  return path.join(getWebToolsDir(), "gateway.json");
}

function readGatewayJson() {
  const filePath = getGatewayJsonPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function connectHostFor(host) {
  const stripped = String(host || "127.0.0.1").trim().replace(/^\[|\]$/g, "");
  const mapped = stripped === "0.0.0.0" ? "127.0.0.1" : stripped === "::" ? "::1" : stripped;
  return mapped.includes(":") ? `[${mapped}]` : mapped;
}

async function checkGatewayHealth(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500) {
  const connectHost = connectHostFor(host);
  const url = `http://${connectHost}:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Gateway health ${url}: HTTP ${res.status}`);
    const json = await res.json();
    if (json?.ok === true && json.value?.status === "healthy" && typeof json.value.version === "string" && Number.isSafeInteger(json.value.pid)) {
      return {
        healthy: true,
        host,
        port,
        url: `http://${connectHost}:${port}`,
        version: json.value.version,
        pid: json.value.pid,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function gatewayBuildPath() {
  const compiledPath = path.join(PROJECT_ROOT, "lib", "host", "gateway-server.js");
  if (!fs.existsSync(compiledPath)) {
    throw new Error("Gateway build is missing lib/host/gateway-server.js. Install the prebuilt plugin ZIP, or run npm ci --include=dev and npm run build in the checkout, then reinstall from that directory.");
  }
  return compiledPath;
}

export async function probeLocalGateway(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const saved = readGatewayJson();
  return checkGatewayHealth(connectHostFor(saved?.host || host), saved?.port || port);
}

async function runForeground(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const existing = await checkGatewayHealth(host, port);
  if (existing) {
    console.log(JSON.stringify({ status: "already-running", ...existing }));
    return;
  }
  const { startGatewayServer } = await import(pathToFileURL(gatewayBuildPath()).href);
  const handle = await startGatewayServer({
    host,
    port,
    projectRoot: PROJECT_ROOT,
  });

  const shutdown = async () => {
    try {
      await handle.close();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    JSON.stringify({
      status: "started",
      pid: process.pid,
      host: handle.host,
      port: handle.port,
      url: handle.url,
    }),
  );
}

function resolveNodeExecutable() {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
  const candidates = [
    ...(/^(node|nodejs)(\.exe)?$/i.test(path.basename(process.execPath)) ? [process.execPath] : []),
    ...pathDirs.map((dir) => path.join(dir, name)),
    ...(process.platform === "win32" ? [] : ["/usr/bin/node", "/usr/local/bin/node"]),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("Node.js executable not found on PATH; cannot start gateway (refusing to invoke the Kimi host binary).");
}

export async function ensureGatewayDaemon(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const health = await probeLocalGateway(host, port);
  if (health) return { status: "running", ...health };

  const nodeExecutable = resolveNodeExecutable();
  gatewayBuildPath();
  const dataDir = getWebToolsDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDir, "gateway.log");
  // Rotate the daemon log once it exceeds 10MB so it cannot grow unbounded.
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 10 * 1024 * 1024) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Missing log file is the normal first-run case.
  }
  const outFd = fs.openSync(logPath, "a");

  let child;
  let spawnError;
  try {
    child = spawn(nodeExecutable, [fileURLToPath(import.meta.url), "--serve"], {
      cwd: PROJECT_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, outFd],
      env: {
        ...process.env,
        KIMI_WEB_TOOLS_HOST: host,
        KIMI_WEB_TOOLS_PORT: String(port),
      },
    });
    child.on("error", error => { spawnError = error; });
    child.unref();
  } finally {
    fs.closeSync(outFd);
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (spawnError) throw new Error(`Gateway spawn failed: ${spawnError.message}; log: ${logPath}`, { cause: spawnError });
    const ready = await checkGatewayHealth(host, port);
    if (ready) return { status: "spawned", ...ready };
    if (child.exitCode !== null || child.signalCode !== null) {
      // Concurrent starters race for the port; our child may have lost the
      // bind (EADDRINUSE) while the winner is already healthy. Re-check once
      // before failing so a concurrent ensure does not surface as an error.
      const winner = await checkGatewayHealth(host, port);
      if (winner) return { status: "spawned", ...winner };
      throw new Error(`Gateway exited before becoming healthy (exit code ${child.exitCode}, signal ${child.signalCode}); log: ${logPath}`);
    }
  }

  throw new Error(`Gateway daemon failed to become healthy on http://${connectHostFor(host)}:${port} within 8s; log: ${logPath}`);
}

function removeGatewayJson() {
  const gwPath = getGatewayJsonPath();
  if (fs.existsSync(gwPath)) {
    try {
      fs.unlinkSync(gwPath);
    } catch {}
  }
}

async function stopGatewayDaemon() {
  const saved = readGatewayJson();
  const pid = saved?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    removeGatewayJson();
    return { status: "stopped", pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
  }

  // Verify identity before signaling: the saved PID may belong to a recycled
  // unrelated process. Confirm via the health endpoint's PID, or on Linux via
  // /proc/<pid>/cmdline mentioning gateway-daemon.mjs.
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === "ESRCH") {
      // The recorded process is already gone; the state file is stale.
      removeGatewayJson();
      return { status: "stopped", pid };
    }
  }
  // A gateway can never be this stop CLI process itself; /proc/<pid>/cmdline
  // would match gateway-daemon.mjs and "verify" the wrong process.
  let verified = pid !== process.pid;
  if (verified) {
    const health = await checkGatewayHealth(saved?.host || DEFAULT_HOST, saved?.port || DEFAULT_PORT);
    verified = health?.pid === pid;
    if (!verified && process.platform !== "win32") {
      try {
        verified = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("gateway-daemon.mjs");
      } catch {}
    }
  }
  if (!verified) {
    // Never signal a live process we cannot confirm is ours; keep the state
    // file for diagnosis.
    return { status: "unverified", pid };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err?.code !== "ESRCH") return { status: "error", pid, error: err?.message };
    removeGatewayJson();
    return { status: "stopped", pid };
  }
  // Wait for a graceful exit before removing the state file; escalate to
  // SIGKILL after the grace window.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === "ESRCH") {
        removeGatewayJson();
        return { status: "stopped", pid };
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  removeGatewayJson();
  return { status: "stopped", pid, forced: true };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "--serve";

  if (cmd === "status" || cmd === "--status") {
    const saved = readGatewayJson();
    const health = await checkGatewayHealth(saved?.host || DEFAULT_HOST, saved?.port || DEFAULT_PORT);
    console.log(
      JSON.stringify(
        {
          running: Boolean(health),
          pid: saved?.pid ?? null,
          ...(health || { host: DEFAULT_HOST, port: DEFAULT_PORT, url: `http://${connectHostFor(DEFAULT_HOST)}:${DEFAULT_PORT}` }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "stop" || cmd === "--stop") {
    const res = await stopGatewayDaemon();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "ensure" || cmd === "--daemon" || cmd === "start-daemon") {
    const res = await ensureGatewayDaemon(DEFAULT_HOST, DEFAULT_PORT);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  await runForeground(DEFAULT_HOST, DEFAULT_PORT);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("[kimi-code-web-search gateway-daemon]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
