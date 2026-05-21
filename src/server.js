// Selma Model Router
// Routes tasks to the appropriate Claude model tier
// Economy → Haiku | Default → Sonnet | Primary → Opus
const TASK_ROUTING = {
  email_triage:      "economy",
  quick_capture:     "economy",
  telegram_routing:  "economy",
  label_classify:    "economy",
  morning_briefing:  "default",
  evening_summary:   "default",
  draft_reply:       "default",
  summarize:         "default",
  deep_research:     "primary",
  lp_analysis:       "primary",
  multi_step_loop:   "primary",
  strategic_planning:"primary",
};
const TIER_MAP = {
  economy: process.env.OPENCLAW_MODEL_ECONOMY  || "anthropic/claude-haiku-4-5",
  default: process.env.OPENCLAW_MODEL_DEFAULT  || "anthropic/claude-sonnet-4-6",
  primary: process.env.OPENCLAW_MODEL_PRIMARY  || "anthropic/claude-opus-4-6",
};
function getModelForTask(taskType) {
  const tier = TASK_ROUTING[taskType] || "default";
  return TIER_MAP[tier];
}
module.exports = { getModelForTask, TASK_ROUTING, TIER_MAP };
