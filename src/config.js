// Optional settings with defaults, shared by the bot and the preflight check.
function readWholeNumber(env, name, { min, max, fallback }) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

// Scan cadence: 30s–3600s, default 60s (gentle on the public data sources).
export const readScanInterval = (env) => readWholeNumber(env, 'SIFT_SCAN_INTERVAL_SECONDS', { min: 30, max: 3600, fallback: 60 });
// How long each new token stays on the watch list: 0–120 minutes, default 30.
// 0 judges tokens only once, at launch.
export const readWatchMinutes = (env) => readWholeNumber(env, 'SIFT_WATCH_MINUTES', { min: 0, max: 120, fallback: 30 });
// Where the SQLite state lives. The systemd service sets /var/lib/sift-bot.
export const readDataDir = (env) => env.SIFT_DATA_DIR?.trim() || '.sift';
