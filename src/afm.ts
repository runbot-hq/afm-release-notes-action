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
  //     "error: apple intelligence unavailable"  — .unavailable(reason) case
  //     "error: unknown model availability state" — @unknown default case
  //     "error: afm-cli requires macos 26+"       — #available guard
  //     "error: foundationmodels framework not available" — #else branch
  //   Non-fatal (retryable — NOT in this list):
  //     "error: inference failed"  — session.respond() throw, may recover on retry
  //
  // SOURCE 2 — OS / MDM errors surfaced via spawnSync result.error or raw stderr.
  //   'not authorized'   — macOS MDM/entitlement denial
  //   'permission denied' — POSIX EACCES.
  //
  //   WHY these are matched with /^.../m (line-anchored) instead of .includes():
  //   The error thrown for a non-zero exit is:
  //     `afm-cli exited ${status}: ${result.stderr?.trim()}`
  //   stderr is passed verbatim. If afm-cli ever echoes back part of a commit
  //   message in its error output (e.g. a commit titled "fix: not authorized
  //   endpoint call"), a bare .includes() would return true and suppress the
  //   cold-start retry — turning a transient ETIMEDOUT into a permanent failure.
  //   Line-anchoring constrains the match to the start of a line in the error
  //   string, which is where the OS/MDM denial strings actually appear.
  //   This is the same invariant the JSDoc previously described as a
  //   "theoretical edge" — it is now enforced structurally rather than assumed.
  //
  //   'mdm policy'       — MDM policy strings (uncommon in commit messages, kept as .includes)
  const msg = String(e).toLowerCase()
  return (
    msg.includes('error: apple intelligence unavailable') ||
    msg.includes('error: unknown model availability state') ||
    msg.includes('error: afm-cli requires macos') ||
    msg.includes('error: foundationmodels framework not available') ||
    /^(error: )?not authorized/m.test(msg) ||
    /^(error: )?permission denied/m.test(msg) ||
    msg.includes('mdm policy')
  )
}
