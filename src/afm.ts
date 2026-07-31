import * as core from '@actions/core'
import { spawnSync } from 'child_process'

/**
 * Calls afm-cli-bin via spawnSync with an explicit argv array.
 *
 * spawnSync is used instead of execSync deliberately — it passes args
 * directly to the OS without invoking a shell, eliminating any risk of
 * shell metacharacter interpretation in prompt content (including
 * prompt_extra from caller-supplied input). Do NOT refactor to execSync
 * with a shell string — the shell-safety of prompt content depends on this.
 *
 * maxBuffer is set to 10 MB. Node's default is 1 MB which can be exceeded
 * by verbose model output before the 120_000 char body cap is applied downstream.
 *
 * On timeout, spawnSync sets result.error to ETIMEDOUT (not result.status).
 * This is handled by the result.error check below and propagates as a thrown
 * error. The caller (step 6 in run()) enriches ETIMEDOUT with context before
 * surfacing to core.setFailed.
 *
 * Flag names mirror the FoundationModels API exactly (see main.swift):
 *   --prompt                   → session.respond(to:)
 *   --instructions             → LanguageModelSession(instructions:) (Apple's term for system prompt)
 *   --temperature              → GenerationOptions.temperature
 *   --maximum-response-tokens  → GenerationOptions.maximumResponseTokens
 *   --count-tokens             → SystemLanguageModel.tokenCount(for:) (macOS 26.4+, no inference)
 */
export function afmCli(bin: string, prompt: string, options?: {
  instructions?: string
  temperature?: number
  maximumResponseTokens?: number
  countTokens?: boolean
}): string {
  const args: string[] = ['--prompt', prompt]

  if (options?.instructions) {
    args.push('--instructions', options.instructions)
  }
  if (options?.temperature !== undefined) {
    args.push('--temperature', String(options.temperature))
  }
  if (options?.maximumResponseTokens !== undefined) {
    args.push('--maximum-response-tokens', String(options.maximumResponseTokens))
  }
  if (options?.countTokens) {
    args.push('--count-tokens')
  }

  if (core.isDebug()) {
    core.debug(`[afm] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`afm-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return result.stdout.trim()
}

/**
 * Returns true if the afm-cli error message indicates a fatal condition that
 * a retry cannot recover from — model unavailable, MDM lockout, permission denied.
 * These map to exit(1) from the availability switch in main.swift.
 * Do NOT retry on these — the error will be identical on the second attempt.
 *
 * ETIMEDOUT is intentionally NOT in this list — a slow cold-start can exceed
 * 60s on first run and is worth one retry after a 15s warm-up pause.
 * If attempt 2 also times out, the error is enriched with context in step 6.
 */
export function isFatalAfmError(e: unknown): boolean {
  // Two distinct error sources feed this function. Do NOT conflate them.
  //
  // SOURCE 1 — main.swift fputs() strings (all begin with "error:", lowercased here).
  //   Fatal (do NOT retry):
  //     "error: apple intelligence unavailable"           — .unavailable(reason) case
  //     "error: unknown model availability state"         — @unknown default case
  //     "error: afm-cli requires macos"                   — #available guard (version number varies)
  //     "error: foundationmodels framework not available" — #else branch
  //   Non-fatal (retryable — NOT in this list):
  //     "error: inference failed"  — session.respond() throw, may recover on retry
  //
  // SOURCE 2 — OS / MDM errors surfaced via spawnSync result.error or raw stderr.
  //   'not authorized'    — macOS MDM/entitlement denial
  //   'permission denied' — POSIX EACCES
  //
  // WHY ALL fatal strings use /^.../im (line-anchored, case-insensitive):
  //
  // The error thrown for a non-zero exit is:
  //   `afm-cli exited ${status}: ${result.stderr?.trim()}`
  // stderr is passed verbatim and can contain arbitrary content — including
  // Apple's debug descriptions that embed human-readable reasons. For example,
  // a future exceededContextWindowSize debug description could embed a phrase
  // like "Apple Intelligence unavailable" as a sub-reason string. A bare
  // .includes() on the full lowercased error string would match that substring
  // and return true, suppressing the cold-start retry on what was actually a
  // retryable inference error.
  //
  // Line-anchoring (/^.../m, matches start of any line) constrains each check
  // to lines that *begin* with the fatal string — exactly where afm-cli emits
  // them. This makes false-positive matches from embedded debug descriptions
  // structurally impossible: an embedded phrase appears mid-line (after a dash,
  // parenthesis, or quote), never at the start of a line.
  //
  // The optional prefix `(afm-cli exited \d+: )?` handles both the wrapped
  // Node throw format (`afm-cli exited 1: error: ...`) and a hypothetical direct
  // stderr line (`error: ...`) with the same pattern. Applied uniformly to all
  // seven patterns — including 'not authorized' and 'permission denied' — so
  // the anchoring invariant holds across the full function without exceptions.
  const msg = String(e).toLowerCase()
  return (
    /^(afm-cli exited \d+: )?error: apple intelligence unavailable/im.test(msg) ||
    /^(afm-cli exited \d+: )?error: unknown model availability state/im.test(msg) ||
    /^(afm-cli exited \d+: )?error: afm-cli requires macos/im.test(msg) ||
    /^(afm-cli exited \d+: )?error: foundationmodels framework not available/im.test(msg) ||
    /^(afm-cli exited \d+: )?(error: )?not authorized/im.test(msg) ||
    /^(afm-cli exited \d+: )?(error: )?permission denied/im.test(msg) ||
    /^(afm-cli exited \d+: )?mdm policy/im.test(msg)
  )
}
