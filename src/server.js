import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

const TASK_ROUTING = {
  // Economy (Haiku) — fast, cheap, no deep reasoning needed
  email_triage:       "economy",
  quick_capture:      "economy",
  telegram_routing:   "economy",
  label_classify:     "economy",
  morning_briefing:   "economy",
  evening_summary:    "economy",
  summarize:          "economy",
  // Default (Sonnet) — solid reasoning, drafting and research
  draft_reply:        "default",
  deep_research:      "default",
  multi_step_loop:    "default",
  // Primary (Opus) — only highest-stakes tasks
  lp_analysis:        "primary",
  strategic_planning: "primary",
};

const TIER_MAP = {
  economy: process.env.OPENCLAW_MODEL_ECONOMY || "anthropic/claude-haiku-4-5",
  default: process.env.OPENCLAW_MODEL_DEFAULT || "anthropic/claude-sonnet-4-6",
  primary: process.env.OPENCLAW_MODEL_PRIMARY || "anthropic/claude-opus-4-6",
};

function getModelForTask(taskType) {
  const tier = TASK_ROUTING[taskType] || "default";
  return TIER_MAP[tier];
}

for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
  }
  delete process.env[oldKey];
}

const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {}

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {}
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ATLAS_EXEC_TIMEOUT_MS = Number.parseInt(
  process.env.ATLAS_EXEC_TIMEOUT_MS ?? "300000", 10
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];
  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

(function migrateLegacyConfigFile() {
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;
  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;
  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

// FIX: Track all active exec child processes for clean SIGTERM shutdown
const activeExecProcs = new Set();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  const net = await import("node:net");
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({
        host: INTERNAL_GATEWAY_HOST,
        port: INTERNAL_GATEWAY_PORT,
        timeout: 750,
      });
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.on("connect", () => done(true));
      sock.on("timeout", () => done(false));
      sock.on("error", () => done(false));
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // FIX: Sanitize cron jobs file before gateway starts to prevent startup crash.
  // Removes any job entries missing a required 'kind' field.
  const cronDir = path.join(STATE_DIR, "cron");
  const cronJobsPath = path.join(cronDir, "jobs.json");
  try {
    fs.mkdirSync(cronDir, { recursive: true });
    if (fs.existsSync(cronJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(cronJobsPath, "utf8"));
      const cleaned = (raw.jobs || []).filter(j => j && j.kind);
      fs.writeFileSync(
        cronJobsPath,
        JSON.stringify({ version: raw.version || 1, jobs: cleaned }),
        "utf8"
      );
      console.log(`[wrapper] cron sanitized: ${cleaned.length} valid job(s) retained`);
    } else {
      fs.writeFileSync(
        cronJobsPath,
        JSON.stringify({ version: 1, jobs: [] }),
        "utf8"
      );
      console.log("[wrapper] cron initialized: empty jobs file created");
    }
  } catch (err) {
    console.warn(`[wrapper] cron sanitize warning: ${err}`);
  }

  const args = [
    "gateway", "run",
    "--bind", "loopback",
    "--port", String(INTERNAL_GATEWAY_PORT),
    "--auth", "token",
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        // Run readiness check in background — does NOT block incoming requests.
        // The proxy error handler returns a clean 502 if gateway isn't ready yet.
        waitForGatewayReady({ timeoutMs: 60_000 }).then((ready) => {
          if (ready) {
            console.log("[wrapper] gateway ready");
          } else {
            console.warn("[wrapper] gateway TCP check timed out — process is running, proceeding anyway");
          }
        }).catch(() => {});
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        console.error(msg);
        lastGatewayError = msg;
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  // Wait up to 3s for spawn to complete, then proceed regardless.
  // Prevents requests from hanging while gateway initializes.
  await Promise.race([gatewayStarting, sleep(3_000)]);
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try { gatewayProc.kill("SIGTERM"); } catch {}
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res.status(500).type("text/plain").send("SETUP_PASSWORD is not set.");
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  const net = await import("node:net");
  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });
    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try { gatewayReachable = await probeGateway(); } catch {}
  }
  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Atlas Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Atlas 🪐 Setup</h1>
  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open Atlas UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>
    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong></div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>
  <div class="card">
    <h2>Debug console</h2>
    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart</option>
        <option value="gateway.stop">gateway.stop</option>
        <option value="gateway.start">gateway.start</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>
  <div class="card">
    <h2>Config editor</h2>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>
  <div class="card">
    <h2>1) Model/auth provider</h2>
    <label>Provider group</label>
    <select id="authGroup"><option>Loading providers…</option></select>
    <label>Auth method</label>
    <select id="authChoice"><option>Loading methods…</option></select>
    <label>Key / Token</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token" />
    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>
  <div class="card">
    <h2>2) Channels</h2>
    <label>Telegram bot token</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <label>Slack bot token</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />
    <label>Slack app token</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>
  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
  </div>
  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace", WORKSPACE_DIR,
    "--gateway-bind", "loopback",
    "--gateway-port", String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth", "token",
    "--gateway-token", OPENCLAW_GATEWAY_TOKEN,
    "--flow", payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "gemini-api-key": "--gemini-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && !secret) throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    if (flag) args.push(flag, secret);
    if (payload.authChoice === "token") {
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }
  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : ATLAS_EXEC_TIMEOUT_MS;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    // FIX: Track active exec processes so SIGTERM handler can clean them up
    activeExecProcs.add(proc);
    proc.on("close", () => activeExecProcs.delete(proc));

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };

    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, { ok: true, output: "Already configured.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"])]));

      const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra += "\n[telegram] skipped\n";
        } else {
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: payload.telegramToken.trim(),
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]));
          const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
          extra += `\n[telegram] exit=${set.code}\n[telegram plugin] exit=${plug.code}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra += "\n[slack] skipped\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]));
          extra += `\n[slack] exit=${set.code}`;
        }
      }

      await restartGateway();
      const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      extra += `\n[doctor --fix] exit=${fix.code}`;
      await restartGateway();
    }

    return respondJson(ok ? 200 : 500, {
      ok,
      output: `[setup] running openclaw onboard...\n${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
    },
    atlas: {
      modelRouter: TASK_ROUTING,
      tierMap: TIER_MAP,
      execTimeoutMs: ATLAS_EXEC_TIMEOUT_MS,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      version: v.output.trim(),
      channels: {
        telegram: {
          exit: tg.code,
          output: redactSecrets(tg.output),
        },
      },
    },
  });
});

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);
  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  "gateway.restart", "gateway.stop", "gateway.start",
  "openclaw.version", "openclaw.status", "openclaw.health",
  "openclaw.doctor", "openclaw.logs.tail", "openclaw.config.get",
  "openclaw.devices.list", "openclaw.devices.approve",
  "openclaw.plugins.list", "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted.\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped.\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Not started: ${r.reason}\n` });
    }
    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", arg]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) {
        return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", arg]));
      return res.json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = configPath();
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }
    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });
    if (isConfigured()) await restartGateway();
    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) return res.status(400).json({ ok: false, error: "Missing channel or code" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId || !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
    const candidates = resolveConfigCandidates();
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
    res.type("text/plain").send("OK - reset complete.\n");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  res.setHeader("content-type", "application/gzip");
  res.setHeader("content-disposition", `attachment; filename="atlas-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`);

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c({ gzip: true, portable: true, noMtime: true, cwd, onwarn: () => {} }, paths);
  stream.on("error", (err) => {
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });
  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res.status(400).type("text/plain").send("Import only supported under /data.\n");
    }
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
    const buf = await readBodyBuffer(req, 250 * 1024 * 1024);
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");
    const tmpPath = path.join(os.tmpdir(), `atlas-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);
    await tar.x({ file: tmpPath, cwd: dataRoot, gzip: true, strict: true, onwarn: () => {}, filter: (p) => looksSafeTarPath(p) });
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    if (isConfigured()) await restartGateway();
    res.type("text/plain").send("OK - imported and restarted.\n");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

const proxy = httpProxy.createProxyServer({ target: GATEWAY_TARGET, ws: true, xfwd: true });

proxy.on("error", (err, _req, res) => {
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {}
});

function requireDashboardAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/hooks")) return next();
  if (!SETUP_PASSWORD) return next();
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Atlas Dashboard"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Atlas Dashboard"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

function attachGatewayAuthHeader(req) {
  if (!req?.headers?.authorization && OPENCLAW_GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }
}

proxy.on("proxyReqWs", (_proxyReq, req) => {
  attachGatewayAuthHeader(req);
});

app.use(requireDashboardAuth, async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }
  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready.\n${String(err)}`);
    }
  }
  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  try { fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true }); } catch {}
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  console.log(`[wrapper] atlas exec timeout: ${ATLAS_EXEC_TIMEOUT_MS}ms`);
  console.log(`[wrapper] atlas model tiers: economy=${TIER_MAP.economy} default=${TIER_MAP.default} primary=${TIER_MAP.primary}`);

  if (!SETUP_PASSWORD) console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set.");

  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    try {
      await runCmd("bash", [bootstrapPath], { timeoutMs: 10 * 60 * 1000 });
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed: ${String(err)}`);
    }
  }

  if (isConfigured() && OPENCLAW_GATEWAY_TOKEN) {
    console.log("[wrapper] syncing gateway tokens in config...");
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] gateway tokens synced");
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway tokens: ${String(err)}`);
    }
  }

  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) { socket.destroy(); return; }
  try { await ensureGatewayRunning(); } catch { socket.destroy(); return; }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// FIX: Graceful SIGTERM handler — kills all active exec processes AND the gateway
// before shutting down, preventing orphaned processes on Railway restarts.
process.on("SIGTERM", () => {
  console.log("[wrapper] SIGTERM received, shutting down gracefully...");
  for (const proc of activeExecProcs) {
    try { proc.kill("SIGTERM"); } catch {}
  }
  try { if (gatewayProc) gatewayProc.kill("SIGTERM"); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 5_000).unref?.();
});
