/**
 * Reads weekly (and optional monthly) usage from claude.ai.
 *
 * The percentages are computed server-side and reported verbatim — this app
 * counts no tokens and carries no pricing table, so it cannot drift from what
 * claude.ai itself shows.
 */
const { store } = require('./config');
const { fetchJson, isAuthError } = require('./fetch-via-window');
const auth = require('./auth');

const USAGE_URL = (org) => `https://claude.ai/api/organizations/${org}/usage`;
const OVERAGE_URL = (org) => `https://claude.ai/api/organizations/${org}/overage_spend_limit`;

/** First moment of next month, local time — when extra usage rolls over. */
function nextMonthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function readMonthly(overage) {
  if (!overage) return null;
  const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
  const used = overage.used_credits ?? overage.balance_cents;
  if (!limit || limit <= 0 || used == null) return null;
  return {
    utilization: Math.max(0, Math.min(100, (used / limit) * 100)),
    resetsAt: nextMonthStart(),
  };
}

/**
 * @returns {Promise<{weekly: {utilization: number, resetsAt: number|null}, monthly: object|null}>}
 */
async function fetchUsage({ includeMonthly = false } = {}) {
  let org = store.get('organizationId');
  if (!org) org = await auth.resolveOrganization();

  const urls = includeMonthly ? [USAGE_URL(org), OVERAGE_URL(org)] : [USAGE_URL(org)];
  const [usage, overage] = await fetchJson(urls);

  const seven = usage?.seven_day;
  // Live sessions always carry a reset timestamp. Its absence means the API
  // handed back an empty shell — a dead session — not genuine zero usage.
  if (!seven || !seven.resets_at) throw new Error('EmptyUsagePayload');

  const five = usage?.five_hour;

  return {
    // The rolling 5-hour window, which claude.ai labels "Current session".
    session: five && five.resets_at
      ? {
        utilization: Math.max(0, five.utilization || 0),
        resetsAt: new Date(five.resets_at).getTime(),
      }
      : null,
    weekly: {
      utilization: Math.max(0, seven.utilization || 0),
      resetsAt: new Date(seven.resets_at).getTime(),
    },
    monthly: includeMonthly ? readMonthly(overage) : null,
  };
}

module.exports = { fetchUsage, isAuthError, nextMonthStart };
