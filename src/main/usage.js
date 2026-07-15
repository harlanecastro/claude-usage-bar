/**
 * Reads usage meters from claude.ai.
 *
 * The percentages are computed server-side and reported verbatim — this app
 * counts no tokens and carries no pricing table, so it cannot drift from what
 * claude.ai itself shows.
 */
const { store } = require('./config');
const { fetchJson, isAuthError } = require('./fetch-via-window');
const auth = require('./auth');

const USAGE_URL = (org) => `https://claude.ai/api/organizations/${org}/usage`;

/**
 * A meter's stable identity, used to remember which ones the user picked.
 * Scoped limits repeat the same `kind`, so the model has to be part of the key.
 */
function meterKey(limit) {
  const model = limit.scope?.model?.display_name;
  return model ? `${limit.kind}:${model}` : limit.kind;
}

/**
 * Reads the self-describing `limits` array claude.ai returns:
 *
 *   { kind: "session",       percent: 61, resets_at: "…", scope: null }
 *   { kind: "weekly_all",    percent: 68, resets_at: "…", scope: null }
 *   { kind: "weekly_scoped", percent: 24, resets_at: "…", scope: { model: { display_name: "Fable" } } }
 *
 * Reading this rather than the older flat five_hour/seven_day_* fields means a
 * meter added on their side shows up here on its own, with its own name.
 */
function readLimits(usage) {
  if (!Array.isArray(usage?.limits)) return [];

  return usage.limits
    .filter((l) => l && l.resets_at && typeof l.percent === 'number')
    .map((l) => ({
      key: meterKey(l),
      kind: l.kind,
      model: l.scope?.model?.display_name ?? null,
      utilization: Math.max(0, l.percent),
      resetsAt: new Date(l.resets_at).getTime(),
    }));
}

/** Older shape, kept so the widget still works if `limits` ever goes missing. */
function readLegacy(usage) {
  const out = [];
  const add = (key, kind, node) => {
    if (node && node.resets_at) {
      out.push({
        key,
        kind,
        model: null,
        utilization: Math.max(0, node.utilization || 0),
        resetsAt: new Date(node.resets_at).getTime(),
      });
    }
  };
  add('session', 'session', usage?.five_hour);
  add('weekly_all', 'weekly_all', usage?.seven_day);
  return out;
}

/**
 * @returns {Promise<Array<{key,kind,model,utilization,resetsAt}>>} every meter
 * the account currently has, in the order claude.ai lists them.
 */
async function fetchUsage() {
  let org = store.get('organizationId');
  if (!org) org = await auth.resolveOrganization();

  const usage = await fetchJson(USAGE_URL(org));

  const meters = readLimits(usage);
  const result = meters.length ? meters : readLegacy(usage);

  // Live sessions always carry reset timestamps. Their absence means the API
  // handed back an empty shell — a dead session — not genuine zero usage.
  if (!result.length) throw new Error('EmptyUsagePayload');

  return result;
}

module.exports = { fetchUsage, isAuthError, meterKey };
