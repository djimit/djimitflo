// SUBSCRIPTION_GYM_SPECIES (services/subscription-gym.ts): the child env of a flat-subscription CLI maker. Kept apart from
// the gym service so executor-env stays free of the evidence import graph.

/** Child-env marker the gym sets on a subscription maker's task; buildExecutorEnv turns it into the subscription env. */
export const SUBSCRIPTION_ENV_MARKER = 'DJIMITFLO_SUBSCRIPTION_AUTH';
/**
 * Everything a CLI could bill per token against (or be routed to a metered proxy by) instead of the subscription login:
 * every `*_API_KEY` (ANTHROPIC_, OPENAI_, OPENCODE_*_, …; a subscription maker needs none) plus the Anthropic auth token
 * and the provider base URLs.
 */
export const isBillingKey = (name: string): boolean =>
  /_API_KEY$/.test(name) || ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'AZURE_OPENAI_ENDPOINT'].includes(name);

/**
 * A subscription maker's child env: billing keys dropped, the login added from the server env (claude: the OAuth token;
 * codex: CODEX_HOME when set — else the CLI reads $HOME/.codex). Any other runtime (opencode-free species: OPENCODE_API_KEY
 * dropped too, so the CLI's built-in 'opencode' provider runs keyless and loads free models only) gets the keys dropped and no login.
 */
export function subscriptionChildEnv(base: NodeJS.ProcessEnv, runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!isBillingKey(k) && k !== SUBSCRIPTION_ENV_MARKER) out[k] = v;
  if (runtime === 'claude' && env.CLAUDE_CODE_OAUTH_TOKEN) out.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (runtime === 'codex' && env.CODEX_HOME) out.CODEX_HOME = env.CODEX_HOME;
  return out;
}
