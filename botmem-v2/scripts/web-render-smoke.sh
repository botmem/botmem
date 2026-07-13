#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BOTMEM_WEB_FIXTURE_PORT:-4174}"
BASE_URL="http://127.0.0.1:${PORT}"
AXI="${CHROME_DEVTOOLS_AXI_BIN:-$HOME/.nvm/versions/node/v25.1.0/bin/chrome-devtools-axi}"
LOG_FILE="$(mktemp -t botmem-web-render-fixture.XXXXXX)"

cleanup() {
  if [[ -n "${FIXTURE_PID:-}" ]]; then kill "${FIXTURE_PID}" 2>/dev/null || true; fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

cd "$ROOT"
pnpm --filter @botmem-v2/web build
node scripts/web-render-fixture.mjs >"$LOG_FILE" 2>&1 &
FIXTURE_PID=$!

for _ in {1..50}; do
  if curl --fail --silent "$BASE_URL/__fixture__/health" >/dev/null; then break; fi
  sleep 0.1
done
curl --fail --silent "$BASE_URL/__fixture__/health" >/dev/null

if [[ ! -x "$AXI" ]]; then
  echo "chrome-devtools-axi is missing at $AXI" >&2
  exit 1
fi

export CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1
"$AXI" pages >/dev/null
"$AXI" resize 1440 1000 >/dev/null

BASE_URL="$BASE_URL" "$AXI" run <<'EOF'
const base = process.env.BASE_URL;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const audit = async (label) => {
  const state = await page.eval(() => ({
    mains: document.querySelectorAll('main').length,
    mainId: document.querySelector('main')?.id,
    skipTarget: document.querySelector('.skip-link')?.getAttribute('href'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    heading: document.querySelector('h1')?.textContent?.trim(),
  }));
  assert(state.mains === 1, `${label}: expected one main landmark`);
  assert(state.mainId === 'main-content', `${label}: missing main-content target`);
  assert(state.skipTarget === '#main-content', `${label}: broken skip link`);
  assert(state.overflow <= 1, `${label}: horizontal overflow ${state.overflow}px`);
  console.log(`${label}: ${state.heading}`);
};

await page.open(`${base}/__fixture__/authenticated`);
await page.wait('#main-content');
await audit('desktop/search');
await page.press('Tab');
assert((await page.eval(() => document.activeElement?.textContent?.trim())) === 'Skip to workspace', 'skip link is not first keyboard stop');
await page.press('Enter');
assert((await page.eval(() => document.activeElement?.id)) === 'main-content', 'skip link did not focus main');

const oldTheme = await page.eval(() => document.documentElement.dataset.theme);
await page.click('.theme-toggle');
assert((await page.eval(() => document.documentElement.dataset.theme)) !== oldTheme, 'theme toggle did not change theme');

await page.eval(() => {
  const input = document.querySelector('#memory-query');
  if (!(input instanceof HTMLInputElement)) throw new Error('memory query input is missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('native input value setter is unavailable');
  setter.call(input, 'launch decision');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'launch decision' }));
});
await page.click('.query-row button');
await page.wait('.result-list');
assert((await page.eval(() => document.querySelectorAll('.result-item').length)) === 2, 'federated results did not render');

await page.eval(() => {
  const input = document.querySelector('#memory-query');
  if (!(input instanceof HTMLInputElement)) throw new Error('memory query input is missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('native input value setter is unavailable');
  setter.call(input, 'partial coverage');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'partial coverage' }));
});
await page.click('.query-row button');
await page.wait('.coverage-warning');
assert((await page.eval(() => document.querySelector('.coverage-warning')?.textContent?.includes('device_disconnected'))) === true, 'partial lane reason is missing');

for (const [position, label] of [[2, 'connections'], [3, 'Mac device'], [4, 'billing'], [5, 'account']]) {
  await page.click(`.view-switcher button:nth-of-type(${position})`);
  await page.wait('#main-content');
  await audit(`desktop/${label}`);
}

await page.open(`${base}/pricing`);
await page.wait('#main-content');
await audit('desktop/pricing');
assert((await page.eval(() => document.body.textContent?.includes('$19.00 / month'))) === true, 'canonical price did not render');
assert((await page.eval(() => document.body.textContent?.includes('CHECKOUT PAUSED'))) === true, 'server-authoritative sales gate did not render');
assert((await page.eval(() => document.querySelector('.checkout-form button')?.disabled)) === true, 'sales gate did not disable Checkout');

await page.open(`${base}/privacy`);
await page.wait('#main-content');
await audit('desktop/privacy');

await page.open(`${base}/pricing`);
await page.eval(() => sessionStorage.setItem('botmem.v2.billing-draft', JSON.stringify({ email: 'owner@example.test', workspaceName: 'Render gate' })));
await page.open(`${base}/signup/complete?session_id=cs_test_render12345678`);
await page.wait('#main-content');
await page.wait('.completion-panel');
assert((await page.eval(() => document.body.textContent?.includes('Your memory layer is ready.'))) === true, 'signup completion did not reconcile');
await audit('desktop/signup-complete');

await page.open(`${base}/__fixture__/login`);
await page.wait('#main-content');
await audit('desktop/login');
EOF

"$AXI" emulate --viewport "390x844x3,mobile,touch" --color-scheme dark >/dev/null
BASE_URL="$BASE_URL" "$AXI" run <<'EOF'
const base = process.env.BASE_URL;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const audit = async (label) => {
  const state = await page.eval(() => ({
    mains: document.querySelectorAll('main').length,
    mainId: document.querySelector('main')?.id,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert(state.mains === 1 && state.mainId === 'main-content', `${label}: invalid main landmark`);
  assert(state.overflow <= 1, `${label}: horizontal overflow ${state.overflow}px`);
  console.log(`${label}: pass`);
};

await page.open(`${base}/pricing`);
await page.wait('#main-content');
await audit('mobile/pricing');
await page.open(`${base}/privacy`);
await page.wait('#main-content');
await audit('mobile/privacy');
await page.open(`${base}/__fixture__/authenticated`);
await page.wait('#main-content');
for (const [position, label] of [[1, 'search'], [2, 'connections'], [3, 'Mac device'], [4, 'billing'], [5, 'account']]) {
  await page.click(`.view-switcher button:nth-of-type(${position})`);
  await page.wait('#main-content');
  await audit(`mobile/${label}`);
}
EOF

CONSOLE_ERRORS="$("$AXI" console --type error --limit 100)"
if [[ -n "$CONSOLE_ERRORS" && "$CONSOLE_ERRORS" != *"No console messages"* && "$CONSOLE_ERRORS" != *"<no console messages found>"* ]]; then
  echo "$CONSOLE_ERRORS" >&2
  exit 1
fi

echo "Current Botmem web production bundle passed the real-Chrome render smoke gate."
