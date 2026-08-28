/**
 * Poll an HTTP endpoint until it answers 2xx, or give up.
 *
 *   node scripts/wait-for.js http://localhost:3000/health --timeout=60000
 *
 * Used by CI to wait for the platform to finish booting before driving it.
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/wait-for.js <url> [--timeout=ms] [--interval=ms]');
  process.exit(2);
}

const argOf = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const timeoutMs = argOf('timeout', 60_000);
const intervalMs = argOf('interval', 1000);
const deadline = Date.now() + timeoutMs;

let lastError = 'no attempt made';

while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`${url} is ready (${res.status}) after ${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s`);
      process.exit(0);
    }
    lastError = `HTTP ${res.status}`;
  } catch (err) {
    lastError = err.message;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

console.error(`Timed out after ${timeoutMs}ms waiting for ${url} — last error: ${lastError}`);
process.exit(1);
