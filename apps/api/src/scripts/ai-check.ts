/**
 * AI preflight check.
 *
 *     npm run ai:check                  (development)
 *     docker compose exec api npm run ai:check:prod
 *
 * Answers "why is AI still showing as not configured?" in one command, because
 * the failure modes are numerous and none of them are obvious from the app's
 * degraded banner alone:
 *
 *   • the key is in `.env.example` rather than `.env`
 *   • the container was started before the key was added (env is fixed at start)
 *   • the key is valid but the configured model has no quota on that tier
 *   • the model exists but is not enabled for the key
 *   • the model answers, but spends its whole output budget "thinking"
 *
 * This walks each layer in order and reports exactly where it stops.
 */
import { env } from '../config/env';

const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)} ${value}`);

const mask = (key: string): string =>
  key.length <= 12 ? '(too short to be valid)' : `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;

interface ModelsResponse {
  models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  error?: { message?: string; code?: number };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { totalTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; code?: number };
}

const main = async (): Promise<void> => {
  console.log('\nAI preflight check\n' + '─'.repeat(60));

  /* --- 1. is a key present at all? ------------------------------------- */
  line('GEMINI_API_KEY', env.GEMINI_API_KEY ? mask(env.GEMINI_API_KEY) : '(empty)');
  line('GEMINI_MODEL', env.GEMINI_MODEL);
  line('GEMINI_API_BASE', env.GEMINI_API_BASE);
  line('aiEnabled', String(env.aiEnabled));
  console.log('─'.repeat(60));

  if (!env.aiEnabled) {
    console.log(
      '\n✖ No API key visible to this process.\n\n' +
        '  Checklist:\n' +
        '    1. The key must be in `.env`, NOT `.env.example`.\n' +
        '       `.env.example` is a committed template the app never reads.\n' +
        '    2. If running in Docker, recreate the containers — environment\n' +
        '       variables are fixed when a container starts, so editing .env\n' +
        '       afterwards has no effect until:\n' +
        '           docker compose up -d --force-recreate api worker\n' +
        '    3. Get a key at https://aistudio.google.com/app/apikey\n',
    );
    process.exit(1);
  }

  /* --- 2. does the key authenticate? ------------------------------------ */
  console.log('\n[1/3] Authenticating…');
  const listResponse = await fetch(`${env.GEMINI_API_BASE}/models`, {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
  });
  const list = (await listResponse.json()) as ModelsResponse;

  if (!listResponse.ok || list.error) {
    console.log(`  ✖ FAILED (HTTP ${listResponse.status}): ${list.error?.message ?? 'unknown error'}`);
    console.log('\n  An invalid key usually means it was revoked, or belongs to a');
    console.log('  different Google Cloud project than the one you enabled the API on.\n');
    process.exit(1);
  }

  const usable = (list.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));

  console.log(`  ✔ key is valid — ${usable.length} models support generateContent`);

  /* --- 3. is the configured model actually usable? ---------------------- */
  console.log(`\n[2/3] Checking that "${env.GEMINI_MODEL}" is listed…`);
  if (!usable.includes(env.GEMINI_MODEL)) {
    console.log(`  ✖ "${env.GEMINI_MODEL}" is not available to this key.`);
    console.log(`\n  Available: ${usable.slice(0, 12).join(', ')}${usable.length > 12 ? ', …' : ''}`);
    console.log('\n  Set GEMINI_MODEL in .env to one of the above.\n');
    process.exit(1);
  }
  console.log('  ✔ listed');

  /* --- 4. does a real structured-output call succeed? -------------------- */
  console.log('\n[3/3] Sending a real structured-output request…');
  const started = Date.now();
  const genResponse = await fetch(
    `${env.GEMINI_API_BASE}/models/${env.GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with {"ok": true}.' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
          maxOutputTokens: 256,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  const gen = (await genResponse.json()) as GenerateResponse;
  const latency = Date.now() - started;

  if (!genResponse.ok || gen.error) {
    const message = gen.error?.message ?? 'unknown error';
    console.log(`  ✖ FAILED (HTTP ${genResponse.status})`);
    console.log(`    ${message.split('\n')[0]}`);

    if (genResponse.status === 429) {
      console.log(
        '\n  HTTP 429 with "limit: 0" means this model has NO free-tier quota on\n' +
          '  your key — it is not a rate limit you can wait out. Either pick a\n' +
          '  model that does have quota, or enable billing on the project.\n' +
          `\n  Models available to this key: ${usable.slice(0, 8).join(', ')}\n`,
      );
    }
    process.exit(1);
  }

  const text = gen.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const thoughts = gen.usageMetadata?.thoughtsTokenCount ?? 0;

  if (!text) {
    console.log(`  ✖ model returned no text (finishReason: ${gen.candidates?.[0]?.finishReason})`);
    if (thoughts > 0) {
      console.log(`    It spent ${thoughts} tokens reasoning and never answered.`);
      console.log('    Raise maxOutputTokens, or keep thinkingBudget at 0.');
    }
    process.exit(1);
  }

  console.log(`  ✔ responded in ${latency}ms — ${text.trim()}`);
  console.log(`    tokens used: ${gen.usageMetadata?.totalTokenCount ?? '?'}`);

  console.log(
    `\n${'─'.repeat(60)}\n✔ AI is fully operational with ${env.GEMINI_MODEL}.\n` +
      '  Scoring, column mapping, NL search and insights will use the model.\n',
  );
};

main().catch((error: Error) => {
  console.error('\n✖ Preflight failed:', error.message, '\n');
  process.exit(1);
});
