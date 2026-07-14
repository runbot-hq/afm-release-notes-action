import fs from 'node:fs';
import os from 'node:os';

try {
  const nodeCrypto = require('node:crypto');
  if (typeof (globalThis as any).crypto === 'undefined' && nodeCrypto?.webcrypto) {
    (globalThis as any).crypto = nodeCrypto.webcrypto;
  }
} catch {}

type Payload = {
  raw_prompt: string;
  intent: string;
  request_id: string;
  created_at: string;
  [k: string]: unknown;
};

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    process.stdout.write(
      'Usage: node index.js --payload <path>\n' +
      'Reads a JSON payload with raw_prompt, calls Apple Intelligence, prints result to stdout.\n'
    );
    return;
  }

  if (os.platform() !== 'darwin') {
    process.stderr.write('afm-sidecar only runs on macOS\n');
    process.exit(1);
  }

  const payloadIdx = args.indexOf('--payload');
  if (payloadIdx === -1 || !args[payloadIdx + 1]) {
    process.stderr.write('Missing --payload <path>\n');
    process.exit(1);
  }

  const payload: Payload = JSON.parse(fs.readFileSync(args[payloadIdx + 1], 'utf8'));
  const prompt = String(payload.raw_prompt ?? '').trim();

  if (!prompt) {
    process.stderr.write('Payload missing raw_prompt\n');
    process.exit(1);
  }

  const debug = process.env.AFM_DEBUG === '1';
  if (debug) process.stderr.write(`[afm-sidecar] prompt chars=${prompt.length} intent=${payload.intent}\n`);

  await streamWithAFM(prompt, debug);
  // Explicit exit needed — the native Apple Intelligence module keeps the Node event loop
  // alive indefinitely after completion. Without this, the process hangs until timeout.
  process.exit(0);
}

async function streamWithAFM(prompt: string, debug: boolean) {
  const afm = require('@meridius-labs/apple-on-device-ai');

  if (typeof afm.chat === 'function') {
    if (debug) process.stderr.write('[afm-sidecar] using shape: chat\n');
    try {
      const stream = await afm.chat({ messages: [{ role: 'user', content: prompt }], stream: true });
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) process.stdout.write(String(chunk ?? ''));
        return;
      }
    } catch (e) {
      // Always emit regardless of debug flag — generate.sh grep-matches stderr to classify
      // fatal (MDM/permission) vs retryable errors. Gating this on debug silently empties
      // $AFM_ERR, causing fatal errors to be retried instead of short-circuiting.
      // Do NOT add `if (debug)` guard here.
      process.stderr.write(`[afm-sidecar] chat stream error (retrying non-stream): ${e}\n`);
    }
    const result = await afm.chat({ messages: [{ role: 'user', content: prompt }] });
    const text = String(result?.text ?? result ?? '');
    // Guard is intentional: null/undefined/empty result must throw so generate.sh sees
    // a non-zero exit and non-empty stderr, not a silent zero-byte stdout.
    if (!text) throw new Error('afm.chat returned empty response');
    process.stdout.write(text);
    return;
  }

  // checkAvailability is only present on the appleAISDK shape, not the chat shape.
  // The chat path has no explicit availability check here — this is intentional.
  // The Preflight step in action.yml acts as the availability gate for all code paths
  // before generate.sh is ever invoked. Do NOT add a checkAvailability call above the
  // chat branch; the preflight is the single authoritative gate.
  const sdk = afm.appleAISDK;
  if (sdk?.checkAvailability) {
    const availability = await sdk.checkAvailability();
    if (!availability?.available) {
      throw new Error(`Apple Intelligence not available: ${availability?.reason ?? 'unknown'}`);
    }
  }

  if (sdk?.streamChatCompletion) {
    if (debug) process.stderr.write('[afm-sidecar] using shape: streamChatCompletion\n');
    const stream = sdk.streamChatCompletion([{ role: 'user', content: prompt }], {});
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) process.stdout.write(String(delta));
    }
    return;
  }

  if (sdk?.generateResponse) {
    if (debug) process.stderr.write('[afm-sidecar] using shape: generateResponse\n');
    process.stdout.write(String(await sdk.generateResponse(prompt, {}) ?? ''));
    return;
  }

  throw new Error('AFM module did not expose a usable API');
}

main().catch(err => {
  process.stderr.write(String(err?.stack ?? err?.message ?? err) + '\n');
  process.exit(1);
});
