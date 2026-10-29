/**
 * PASS PROBE (live, opt-in, Run 5): send ONE localization pass for ONE test2/ photo,
 * built exactly as the pipeline builds it (normalized 1024² image, the 23- or
 * 26-food dinner menu, the base prompt, plus the close-up line for pass 2), with
 * a chosen thinking setting. No retries, no SAM, nothing stored. Prints the
 * time, the token counts (thinking vs. answer), the finish reason and the pieces.
 *
 *   RUN_LIVE=1 node --env-file=../.env live/pass-probe.mjs --photo IMG_2706 --pass 2 \
 *     [--thinking-budget 1024 | --thinking-level LOW] [--timeout-ms 300000] [--exclude-items 'Halal Rice,Tomatoes,Lettuce']
 *
 * Exactly 1 Gemini call per run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO, capture, data, test2Photos, vision } from '../support/stack.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
if (process.env.RUN_LIVE !== '1') {
  console.log('set RUN_LIVE=1 to run (1 Gemini call)');
  process.exit(0);
}
const PHOTO = arg('photo', 'IMG_2706');
const PASS = Number(arg('pass', 2));
const BUDGET = arg('thinking-budget', undefined);
const LEVEL = arg('thinking-level', undefined);
const EXCLUDE = new Set(arg('exclude-items', 'Halal Rice,Tomatoes,Lettuce').split(',').map((x) => x.trim()).filter(Boolean));
const localize = await import(path.join(REPO, 'vision/dist/src/localize.js'));
const { GoogleGenAI } = await import(path.join(REPO, 'vision/node_modules/@google/genai/dist/node/index.mjs'));

const photo = (await test2Photos()).find((p) => path.basename(p).startsWith(PHOTO));
if (!photo) throw new Error(`no test2 photo ${PHOTO}`);
const norm = await capture.normalizeImage(readFileSync(photo));
const seed = await import(path.join(REPO, 'data/dist/data/src/seed/generate.js'));
const items = seed.factorDinnerItems().filter((it) => !EXCLUDE.has(it.name)).map((it) => ({
  itemId: `item_probe_${data.factorKeyFor(it.name)}`, menuId: 'menu_probe', displayName: it.name, category: it.category,
  ...(it.description ? { description: it.description } : {}),
}));
const base = localize.buildLocalizePrompt(items, norm.geometry);
const prompt = PASS === 2 ? `${base}\n${localize.CLOSEUP_LINE}` : base;
const thinkingConfig = LEVEL ? { thinkingLevel: LEVEL } : BUDGET !== undefined ? { thinkingBudget: Number(BUDGET) } : undefined;
const timeoutMs = Number(arg('timeout-ms', 300000));

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
const t0 = Date.now();
let res;
let error = null;
try {
  res = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: norm.mimeType, data: Buffer.from(norm.bytes).toString('base64') } }, { text: prompt }] }],
    config: {
      abortSignal: AbortSignal.timeout(timeoutMs), systemInstruction: localize.LOCALIZE_SYSTEM_INSTRUCTION, temperature: 0, seed: 42,
      responseMimeType: 'application/json', responseSchema: localize.buildLocalizeSchema(items.length),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  });
} catch (err) {
  error = err?.name === 'AbortError' || /abort/i.test(String(err?.message)) ? `timed out after ${timeoutMs} ms` : String(err?.message ?? err);
}
const ms = Date.now() - t0;
const u = res?.usageMetadata ?? {};
let pieces = null;
try {
  const j = JSON.parse(res?.text ?? 'null');
  const list = Array.isArray(j) ? j : j?.pieces ?? [];
  pieces = list.map((p) => `${items[(p.menu_id ?? 0) - 1]?.displayName ?? `menu_id ${p.menu_id}`}${p.on_target_dish === false ? ' (other dish)' : ''}`);
} catch {
  pieces = 'unparsable';
}
console.log(JSON.stringify({
  photo: PHOTO, pass: PASS, model, image: norm.geometry, menuItems: items.length, thinkingConfig: thinkingConfig ?? 'model default',
  seconds: +(ms / 1000).toFixed(1), error, finishReason: res?.candidates?.[0]?.finishReason ?? null,
  tokens: { prompt: u.promptTokenCount, thinking: u.thoughtsTokenCount, answer: u.candidatesTokenCount, total: u.totalTokenCount },
  answerChars: res?.text?.length ?? null, pieces,
}, null, 1));
