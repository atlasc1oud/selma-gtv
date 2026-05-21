[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/setup/healthz"
healthcheckTimeout = 300
restartPolicyType = "on_failure"
requiredMountPath = "/data"

[variables]
OPENCLAW_STATE_DIR = "/data/.openclaw"
OPENCLAW_WORKSPACE_DIR = "/data/workspace"
