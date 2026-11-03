// End-to-end run in headless Chrome, in a fresh profile, with a microphone this script speaks
// into: `getUserMedia` returns a silent stream, and each WAV of fixtures/calls (the caller's lines,
// `just fixtures`) is played into it once the page gives the caller the floor. (Chrome's fake
// capture device needs the system's microphone permission on macOS, which a headless run does not
// get; everything after `getUserMedia` is the page's own path.)
//
// 1. Open the page, wait for the three models and start the call.
// 2. Speak each line and wait for its reply to play out. Every turn must be heard as it was said
//    (`MAX_WER`), get a reply, and have every stage of its latency measured; nothing may be
//    requested after the models were ready.
// 3. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs [--build web-threaded]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// Results (JSON with every turn's latency, screenshots) go to e2e/results/<timestamp>-*, or to
// `--out <dir>`.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';
import { wordErrorRate } from '../scripts/wer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({});
const DEADLINE_MS = 10 * 60 * 1000;
const TURN_MS = 60 * 1000;
// The caller's words as Parakeet Redux hears Phonon's speech of them.
const MAX_WER = 0.15;
const CALLS = join(ROOT, 'fixtures/calls');
const lines = readFileSync(join(ROOT, 'fixtures/caller.txt'), 'utf8').split('\n').filter(Boolean);
const clips = readdirSync(CALLS).filter((file) => file.endsWith('.wav')).sort();

// The page's state machine is `main[data-phase]`: loading, idle, calling, broken.
const loadedOrBroken = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const listening = () => document.querySelector('#status')?.textContent.startsWith('Listening') || document.querySelector('main')?.dataset.phase === 'broken';
const played = (count) => document.querySelectorAll('#latency tbody tr[data-played="true"]').length >= count || document.querySelector('main')?.dataset.phase === 'broken';

/** In the page: `getUserMedia` resolves to a silent stream that `speakIntoMicrophone` plays into. */
function fakeMicrophone() {
  let context = null;
  let destination = null;
  navigator.mediaDevices.getUserMedia = async () => {
    context = new AudioContext();
    destination = context.createMediaStreamDestination();
    return destination.stream;
  };
  window.speakIntoMicrophone = async (wav) => {
    const bytes = Uint8Array.from(atob(wav), (character) => character.charCodeAt(0));
    const source = context.createBufferSource();
    source.buffer = await context.decodeAudioData(bytes.buffer);
    source.connect(destination);
    source.start();
  };
}

/** The latency table's header, each turn's cells and the medians, and the conversation. */
function readCall() {
  const cells = (row) => [...row.children].map((cell) => cell.textContent.trim());
  const table = document.querySelector('#latency');
  return {
    columns: cells(table.tHead.rows[0]),
    turns: [...table.tBodies[0].rows].map(cells),
    medians: cells(table.tFoot.rows[0]),
    exchanges: [...document.querySelectorAll('.conversation li')].map((item) => ({
      caller: item.querySelector('.caller').textContent,
      reply: item.querySelector('.assistant').textContent,
    })),
    network: document.querySelector('#network').textContent,
  };
}

const launch = {
  root: ROOT,
  name: 'voice-call',
  values,
  fields: { lines },
  args: ['--autoplay-policy=no-user-gesture-required'],
  init: [fakeMicrophone],
};
await run(launch, async ({ page, requests, query, base, runDir, results, check, revisit }) => {
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  results.loadMs = Date.now() - t0;
  results.runtime = await page.textContent('#runtime');
  results.engines = await page.$$eval('.engine', (engines) => engines.map((engine) => engine.innerText.replace(/\s+/g, ' ')));
  check((await page.getAttribute('main', 'data-loaded')) === 'true', `models loaded in ${(results.loadMs / 1000).toFixed(1)} s (${results.runtime})`);
  const mark = requests.length;

  await page.click('#call');
  for (const [index, clip] of clips.entries()) {
    await page.waitForFunction(listening, null, { timeout: TURN_MS, polling: 50 });
    await page.evaluate((wav) => window.speakIntoMicrophone(wav), readFileSync(join(CALLS, clip)).toString('base64'));
    await page.waitForFunction(played, index + 1, { timeout: TURN_MS, polling: 100 });
  }
  await page.screenshot({ path: join(runDir, `${STAMP}-call.png`), fullPage: true });
  Object.assign(results, await page.evaluate(readCall));
  check(results.exchanges.length === lines.length, `${results.exchanges.length} of ${lines.length} turns heard and answered`);
  for (const [index, { caller, reply }] of results.exchanges.entries()) {
    const rate = wordErrorRate(lines[index] ?? '', caller);
    check(rate <= MAX_WER, `turn ${index + 1} heard with WER ${rate.toFixed(2)}: "${caller}"`);
    check(reply.length > 0, `turn ${index + 1} answered: "${reply}"`);
    const unmeasured = results.columns.filter((_, column) => results.turns[index][column] === '–');
    check(!unmeasured.length, `turn ${index + 1} response ${results.turns[index][1]}${unmeasured.length ? `, unmeasured: ${unmeasured.join(', ')}` : ''}`);
  }
  check(results.network.startsWith('0 '), `the engines: ${results.network}`);
  const late = fetched(requests, mark);
  check(!late.length, `nothing fetched during the call${late.length ? `: ${late.join(', ')}` : ''}`);
  console.log([results.columns, ...results.turns, results.medians].map((row) => row.map((text) => text.padStart(16)).join('')).join('\n'));

  await revisit(loadedOrBroken, DEADLINE_MS);
});
