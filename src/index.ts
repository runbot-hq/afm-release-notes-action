import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as crypto from 'crypto'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string, env?: Record<string, string>): string {
  // { shell: '/bin/sh' } is intentional: several callers use shell pipes
  // (e.g. | head -n 1, | grep -vxF) for tag resolution. All user-controlled
  // values (tag, prevTag) are passed via env vars and referenced as "$VAR"
  // (double-quoted) in the command string — never interpolated directly.
  //
  // shell is '/bin/sh' not true — TypeScript 5.9 tightened ExecSyncOptions.shell
  // to string | undefined; boolean is no longer assignable. '/bin/sh' is correct
  // and equivalent: Node's child_process uses /bin/sh when shell: true anyway.
  // Do NOT revert to shell: true — it fails to compile with typescript@5.9+.
  //
  // Do NOT replace with execFileSync — the pipe operator requires a shell.
  // CALLERS MUST NOT interpolate user-controlled values directly into cmd.
  // Always use the env parameter and reference values as "$VAR_NAME" (double-quoted).
  if (/\$\{/.test(cmd)) {
    throw new Error(`git() cmd must not use template-literal interpolation (use env param instead): ${cmd}`)
  }
  return execSync(`git ${cmd}`, {
    encoding: 'utf8',
    shell: '/bin/sh',
    env: { ...process.env, ...env },
  }).trim()
}

// PARSE_FAILED is declared at module scope, not inside parseAfmOutput.
// Symbol() creates a unique object on every call — if it were declared inside
// the function, each invocation would have a distinct symbol and the
// `parsed !== PARSE_FAILED` guard would still work within that single call
// (both sides reference the same local binding). However a module-level const
// is the conventional pattern for a stable sentinel: it is immune to any future
// refactor that caches or shares `parsed` across calls (e.g. a memoisation pass
// or a test helper that pre-assigns the sentinel), where a per-call symbol would
// silently fail the equality check.
// Do NOT move PARSE_FAILED back inside parseAfmOutput.
const PARSE_FAILED = Symbol('PARSE_FAILED')

// ---------------------------------------------------------------------------
// Binary bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures afm-cli-bin is present at ~/.cache/runbot-hq/afm-cli-bin and
 * up-to-date with the latest runbot-hq/afm-cli release.
 *
 * Cache invalidation uses the release asset digest (sha256: prefix) when
 * present, falling back to the asset's updated_at timestamp. A .digest
 * sidecar file stores the last-seen cache key; on cache hit the download
 * is skipped entirely. On cache miss or stale key the binary is re-downloaded,
 * sha256-verified (when a digest is available), and the sidecar is updated.
 *
 * ~/.cache/runbot-hq persists across jobs on self-hosted runners — in contrast
 * to RUNNER_TEMP which is wiped after every job. This means the binary is
 * downloaded once per runner per release, not once per workflow run.
 *
 * Auth token is passed to the GitHub API call (releases/latest) but NOT to
 * httpsDownload — browser_download_url for public releases redirects to an
 * unauthenticated CDN URL; sending a Bearer token there causes HTTP 400.
 *
 * Atomicity: the binary is downloaded to a per-process temp path
 * (binPath + '.tmp.' + process.pid) and renamed into place only after
 * sha256 verification (when a digest is present). rename(2) is atomic on
 * APFS/HFS+ — concurrent parallel jobs on the same runner cannot interleave
 * byte writes into the shared binPath. The temp file is cleaned up in a
 * finally block regardless of success or failure.
 */
async function ensureBinary(token: string): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'afm-cli-bin')
  const digestPath = path.join(cacheDir, 'afm-cli-bin.digest')

  core.info(`[afm] Cache dir: ${cacheDir}`)
  core.info(`[afm] Bin path:  ${binPath}`)
  core.info(`[afm] Checking latest runbot-hq/afm-cli release...`)

  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/afm-cli/releases/latest', token)
  // String() coercion is intentional — `as string` cast is evaluated before ??
  // and would lie to the type system if the value is undefined (cast succeeds
  // at the type level but the runtime value is still undefined, so ?? fires
  // correctly by accident). String(value ?? fallback) is honest and explicit.
  const tagName = String(release.tag_name ?? 'unknown')
  const publishedAt = String(release.published_at ?? '')
  core.info(`[afm] Latest release tag: ${tagName} published_at: ${publishedAt}`)

  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string; updated_at?: string }>)
    .find((a) => a.name === 'afm-cli-bin')
  if (!asset) {
    const assetNames = (release.assets as Array<{ name: string }>).map(a => a.name).join(', ')
    throw new Error(
      `afm-cli-bin asset not found in release ${tagName} of runbot-hq/afm-cli. ` +
      `Available assets: [${assetNames}]`
    )
  }
  core.info(`[afm] Found asset: ${asset.name} (${asset.browser_download_url})`)

  const remoteDigest: string = asset.digest ?? ''
  const cacheKey: string = remoteDigest || `updated_at:${asset.updated_at ?? publishedAt ?? tagName}`
  core.info(`[afm] Remote digest: ${remoteDigest || '(none — using updated_at as cache key)'}`)
  core.info(`[afm] Cache key: ${cacheKey}`)

  const binExists = fs.existsSync(binPath)
  const digestExists = fs.existsSync(digestPath)
  core.info(`[afm] Cache state: bin=${binExists}, digest=${digestExists}`)

  if (binExists && digestExists) {
    const cachedKey = fs.readFileSync(digestPath, 'utf8').trim()
    core.info(`[afm] Cached key: ${cachedKey}`)
    if (cachedKey === cacheKey) {
      const binSize = fs.statSync(binPath).size
      core.info(`[afm] Cache hit ✔ — skipping download (size: ${binSize} bytes)`)
      return binPath
    }
    core.info(`[afm] Cache stale — re-downloading`)
  } else {
    core.info(`[afm] No cached binary — downloading for the first time`)
  }

  fs.mkdirSync(cacheDir, { recursive: true })

  // Download to a per-process temp path, then atomically rename into binPath.
  // This prevents concurrent parallel jobs on the same runner from interleaving
  // byte writes — two jobs can both download simultaneously but rename(2) is
  // atomic on APFS/HFS+, so the last writer wins with a complete binary.
  // The temp file is cleaned up in the finally block regardless of outcome.
  const tmpPath = `${binPath}.tmp.${process.pid}`
  try {
    core.info(`[afm] Downloading ${asset.browser_download_url} ...`)
    const downloadStart = Date.now()
    await httpsDownload(asset.browser_download_url, tmpPath)
    const downloadMs = Date.now() - downloadStart
    const binSize = fs.statSync(tmpPath).size
    core.info(`[afm] Download complete in ${downloadMs}ms (${binSize} bytes)`)

    // Guard against zero-byte downloads. A CDN can return HTTP 200 with an
    // empty body in the narrow window before --fail would trigger. A zero-byte
    // file passes chmodSync and accessSync(X_OK) but causes ENOEXEC at
    // spawnSync, producing a confusing error. Catch it here and fail loudly.
    // The digest sidecar is not written on this path so the next run will
    // re-download cleanly. Do NOT remove this check.
    if (binSize === 0) {
      throw new Error('Downloaded afm-cli-bin is zero bytes — CDN may have returned an empty 200 response. Retry the workflow.')
    }

    if (remoteDigest && remoteDigest.startsWith('sha256:')) {
      const expectedHex = remoteDigest.slice('sha256:'.length)
      core.info(`[afm] Verifying sha256...`)
      const actualHex = sha256File(tmpPath)
      if (actualHex !== expectedHex) {
        throw new Error(
          `afm-cli-bin digest mismatch — expected sha256:${expectedHex}, got sha256:${actualHex}. ` +
          'The downloaded binary may be corrupted. Retry the workflow.'
        )
      }
      core.info(`[afm] Digest verified ✔ sha256:${actualHex}`)
    } else {
      core.info(`[afm] No sha256 digest to verify — skipping integrity check`)
    }

    fs.chmodSync(tmpPath, 0o755)
    // Atomic rename: replaces binPath in a single syscall on APFS/HFS+.
    // Any concurrent job that already renamed its own tmp wins or loses cleanly —
    // both outcomes leave a valid, complete binary at binPath.
    fs.renameSync(tmpPath, binPath)
    fs.writeFileSync(digestPath, cacheKey, 'utf8')
  } finally {
    // Clean up the temp file if it still exists (download failed, verify threw, etc.).
    try { fs.unlinkSync(tmpPath) } catch { /* already renamed or never created */ }
  }

  core.info(`[afm] Binary ready at ${binPath}`)
  return binPath
}

function httpsGetJson(url: string, token?: string, redirectsLeft = 5): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'runbot-hq/afm-release-notes-action',
      'Accept': 'application/vnd.github+json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`))
        // res.resume() drains and releases the socket back to the connection pool.
        // Without this, the unconsumed readable stream holds the socket open until
        // the server closes it or the connection times out. Do NOT remove.
        res.resume()
        resolve(httpsGetJson(res.headers.location, token, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${url}`))
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e}`)) }
      })
    })
    req.on('error', reject)
  })
}

// Auth token is intentionally NOT forwarded to httpsDownload.
// browser_download_url for public GitHub releases resolves via a 302 redirect
// to an unauthenticated S3/CDN URL — sending a Bearer token there causes HTTP 400.
// Do NOT add token forwarding here without also switching to the GitHub API
// asset-download endpoint (which supports auth correctly).
function httpsDownload(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'runbot-hq/afm-release-notes-action' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`))
        // res.resume() drains and releases the socket back to the connection pool.
        // Without this, the unconsumed readable stream holds the socket open until
        // the server closes it or the connection times out. Do NOT remove.
        res.resume()
        resolve(httpsDownload(res.headers.location, destPath, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`Download returned HTTP ${res.statusCode} for ${url}`))
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
    })
    // Unlink destPath on TCP/DNS failure before a response is received.
    // Without this, a failed connection can leave an empty or partial file
    // on disk. The digest sidecar won't exist so the next run will re-download,
    // but createWriteStream would truncate the stale file anyway — the real
    // risk is a lingering zero-byte file if the stream was never opened.
    // Mirrors the file.on('error') cleanup above. Do NOT remove.
    req.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
  })
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

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
 */
function afmCli(bin: string, prompt: string, options?: {
  instructions?: string
  temperature?: number
  maximumResponseTokens?: number
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
function isFatalAfmError(e: unknown): boolean {
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
  //   'permission denied' — POSIX EACCES, matched via Node.js error message rather
  //                         than err.code so it catches both Error objects and raw
  //                         stderr strings from spawnSync. 'eacces' was used previously
  //                         but is too broad — it can appear in file paths or commit
  //                         messages propagated into error strings, causing a false-fatal
  //                         classification that suppresses a potentially recoverable retry.
  //                         'permission denied' is the canonical OS-level message for
  //                         EACCES on macOS and is far less likely to appear accidentally
  //                         in non-permission-related error text.
  //   'mdm policy'       — MDM policy strings
  const msg = String(e).toLowerCase()
  return (
    msg.includes('error: apple intelligence unavailable') ||
    msg.includes('error: unknown model availability state') ||
    msg.includes('error: afm-cli requires macos') ||
    msg.includes('error: foundationmodels framework not available') ||
    msg.includes('not authorized') ||
    msg.includes('permission denied') ||
    msg.includes('mdm policy')
  )
}

/**
 * Returns true when the AFM error is a hard context-window overflow
 * (exceededContextWindowSize). This is a deterministic limit — retrying
 * with the same prompt will always fail. The caller must reduce the prompt
 * before retrying. Do NOT add this string to isFatalAfmError: it IS
 * recoverable, just not via a simple pause-and-retry.
 */
function isContextOverflowError(e: unknown): boolean {
  return String(e).toLowerCase().includes('exceededcontextwindowsize')
}

/**
 * Parses AFM output into { title, body }.
 *
 * Handles three recognised formats in priority order:
 *   A. { "title": "...", "body": "..." }           ideal
 *   B. Double-encoded string of A                  fromjson then extract
 *   C. { "Added": [...], "Changed": [...], ... }   section-keyed; convert to Markdown
 *
 * THROWS on unrecognised output (format D / prose) so the caller can retry
 * with a stricter prompt. Do NOT add a prose fallback that returns silently —
 * a silent fallback makes the retry catch block in run() unreachable dead code.
 *
 * Empty title or body after a successful parse emits a warning and throws so
 * the caller's strict-prompt retry fires with a useful signal rather than
 * silently falling through to the section-keyed branch.
 *
 * Format B double-decode (JSON.parse on a string value) is wrapped in its own
 * try/catch so a quoted plain string from the model produces the descriptive
 * "did not match any known format" error rather than a raw SyntaxError.
 * On inner parse failure, obj is set to {} and falls through to the format-C
 * check and then the throw. This is intentional — obj = {} is NOT a bug;
 * it is the correct way to reach the unrecognised-format throw path.
 * A core.debug log is emitted so the inner error is visible in debug mode.
 *
 * Fence stripping: all three replace patterns use the /m flag so ^ and $
 * anchor to line boundaries. Without /m on the closing-fence pattern,
 * trailing whitespace after the fence causes the replace to silently no-op,
 * leaving the fence in the string and causing JSON.parse to fail.
 *
 * Sentinel: PARSE_FAILED is declared at module scope (above this function).
 * Symbol() creates a new unique object on every call — a per-call declaration
 * would work within a single invocation but is fragile across refactors.
 * See the module-level comment above the PARSE_FAILED declaration for the full
 * rationale. Do NOT move PARSE_FAILED back inside this function.
 *
 * Format C element coercion: obj[s] is cast via String(l) rather than a
 * `l: string` type annotation. Array.isArray guards array presence but not
 * element types — a model returning { "Added": [1, 2, 3] } passes the guard
 * and the type annotation silently accepts numbers. String() coercion makes
 * the output correct regardless of element type. Do NOT revert to `l: string`.
 *
 * Second parseAfmOutput call (after strict-prompt retry in run() step 7):
 * if it throws, the error propagates directly to the outer catch in run() and
 * surfaces via core.setFailed. This is intentional — two consecutive parse
 * failures mean the model is not following the format instruction and a third
 * attempt is unlikely to help. No additional try/catch is needed here.
 * Do NOT wrap the second call in another try/catch.
 */
function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')  // /m required — $ must anchor to end-of-line, not end-of-string
    .trim()

  // PARSE_FAILED is module-scoped — see declaration above and JSDoc above.
  // Do NOT re-declare PARSE_FAILED inside this function.
  let parsed: unknown = PARSE_FAILED
  try {
    parsed = JSON.parse(cleaned)
  } catch { /* not valid JSON — parsed stays PARSE_FAILED */ }

  if (parsed !== PARSE_FAILED) {
    // Format B: double-encoded string — decode one more level.
    // Wrapped in try/catch: if the model returned a quoted plain string
    // (not valid JSON inside), JSON.parse throws a SyntaxError here.
    // We catch it and fall through to the format-C / throw path rather
    // than surfacing a raw SyntaxError to core.setFailed.
    // obj = {} on failure is intentional — it is the correct way to reach
    // the unrecognised-format throw below. Do NOT treat it as a missing error.
    let obj: Record<string, unknown>
    if (typeof parsed === 'string') {
      try {
        obj = JSON.parse(parsed) as Record<string, unknown>
      } catch (e) {
        core.debug(`[afm] Format B double-decode failed (inner parse error): ${e}`)
        obj = {}
      }
    } else {
      obj = parsed as Record<string, unknown>
    }

    // Format A/B: { title, body }
    if (typeof obj?.title === 'string' && typeof obj?.body === 'string') {
      if (obj.title.length === 0 || obj.body.length === 0) {
        core.warning(
          `AFM returned a {title, body} object but ${ obj.title.length === 0 ? 'title' : 'body'} is empty. ` +
          'This may indicate the model found no diffable content. Triggering strict-prompt retry.'
        )
        throw new Error('AFM returned empty title or body in {title, body} object')
      }
      return { title: String(obj.title), body: String(obj.body) }
    }

    // Format C: section-keyed { Added, Changed, ... }
    // String(l) is intentional — not `l: string`. Array.isArray guards presence
    // but not element types. String() coerces numbers/booleans safely.
    // Do NOT revert to a type annotation here.
    const sections = ['Added', 'Changed', 'Fixed', 'Removed', 'Security']
    const hasSections = sections.some(s => Array.isArray(obj[s]) && (obj[s] as unknown[]).length > 0)
    if (hasSections) {
      core.warning('AFM returned section-keyed JSON — converting to {title, body}')
      const body = sections
        .filter(s => Array.isArray(obj[s]) && (obj[s] as unknown[]).length > 0)
        .map(s => `## ${s}\n${(obj[s] as unknown[]).map(l => `- ${String(l)}`).join('\n')}`)
        .join('\n\n')
      return { title: currentTag || 'Release', body }
    }
  }

  throw new Error(`AFM output did not match any known format. Raw: ${raw.slice(0, 200)}`)
}

// WHY MAX_PROMPT_CHARS is declared here (before buildPrompt/truncatePromptToFit):
//
// truncatePromptToFit references MAX_PROMPT_CHARS in its body. TypeScript const
// declarations are subject to the Temporal Dead Zone — referencing a const before
// its declaration in source order is a runtime ReferenceError if the reference is
// evaluated at declaration time (e.g. a default parameter or class field). The
// function body is only evaluated at call time (after module evaluation), so the
// previous order was safe at runtime. However, declaring the constant after the
// function that uses it is a readability hazard and a latent footgun if the call
// site ever moves earlier. Constant declared first, then the functions that use it.
//
// WHY 12_000 and not 13_500 (the previous value)?
// The failure in issue #2351 showed 4,091 tokens from 13,500 chars — a real density
// of ~3.29 chars/token, not the assumed 3–3.5. The instructions string passed to
// LanguageModelSession(instructions:) also consumes context tokens on top of the
// prompt. Corrected formula:
//   4096 - 300 (response headroom) - 60 (instructions) = 3,736 available prompt tokens
//   3,736 × 3.29 chars/token ≈ 12,292 → rounded down to 12,000
// At 12,000 chars the same worst-case density produces ~3,647 tokens — 449 tokens
// of headroom instead of the previous 5. Do NOT raise this without re-measuring
// real token counts on dense commit logs.
const MAX_PROMPT_CHARS = 12_000

/**
 * Assembles the prompt string from its components.
 *
 * Called by truncatePromptToFit on every halving iteration — keep it cheap.
 *
 * safeTag/safePrevTag must already have control chars stripped (\x00-\x1f\x7f)
 * before being passed here — they are embedded directly into the template.
 */
function buildPrompt(
  safeTag: string,
  safePrevTag: string,
  commits: string[],
  files: string[],
  promptExtra: string
): string {
  return [
    'Generate GitHub release notes as JSON with exactly two keys: "title" and "body".',
    'Rules:',
    `- title: include the version tag (${safeTag}) and a short human-readable summary.`,
    '- body: Markdown with sections ## Added, ## Changed, ## Fixed, ## Removed, ## Security (omit empty sections).',
    '- User-facing language, past tense.',
    '- Skip bot commits (dependabot, renovate, github-actions) and merge commits.',
    '- Output JSON only — no markdown fences, no extra keys.',
    '',
    `Previous tag: ${safePrevTag}`,
    `Target tag: ${safeTag}`,
    '',
    'Commits:',
    ...commits.map(c => `- ${c}`),
    '',
    'Changed files:',
    ...files.map(f => `- ${f}`),
    ...(promptExtra ? ['', `Extra instructions: ${promptExtra}`] : []),
  ].join('\n')
}

/**
 * Rebuilds the prompt string from its components, capping the total length
 * to charBudget (defaults to MAX_PROMPT_CHARS) to stay within AFM's 4096-token
 * context window.
 *
 * WHY charBudget is a parameter and not always MAX_PROMPT_CHARS:
 * ANSWER: The strict-retry path appends a ~130-char suffix to the prompt.
 * To guarantee the suffix is never truncated, the caller passes
 * MAX_PROMPT_CHARS - strictSuffix.length as the budget. The default
 * (MAX_PROMPT_CHARS) is used for the normal first-attempt call.
 * The overflow-retry path passes Math.floor(prompt.length * 0.75) so the
 * re-truncated prompt is guaranteed to be smaller than the overflowing one.
 *
 * WHY 12_000 and not 16_384 (4096 tokens × 4 chars/token)?
 * ANSWER: The 4 chars/token estimate is conservative — real token counts for
 * code/commit messages run 3–3.5 chars/token. 12_000 gives ~449 tokens of
 * headroom for the instructions string (~60 tokens) and the model response
 * (~389 tokens usable). Do NOT raise this without re-measuring real token counts.
 *
 * WHY progressively halve instead of binary-search?
 * ANSWER: The loop runs at most log2(80) ≈ 7 times. Binary search adds
 * complexity for negligible gain at these sizes.
 *
 * WHY we keep at least 0 items (empty lists) rather than throwing?
 * ANSWER: A prompt with just the tag names and rules is still valid input for AFM
 * — it will produce a minimal release note rather than failing the job.
 * Failing here would be worse than a thin release note.
 */
function truncatePromptToFit(
  safeTag: string,
  safePrevTag: string,
  commits: string[],
  files: string[],
  promptExtra: string,
  charBudget: number = MAX_PROMPT_CHARS
): { prompt: string; commits: string[]; files: string[] } {
  let c = [...commits]
  let f = [...files]

  let prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  if (prompt.length <= charBudget) return { prompt, commits: c, files: f }

  // Halve both lists progressively until the assembled prompt fits charBudget.
  //
  // DOES THIS LOOP TERMINATE?
  // ANSWER: Yes, always. Math.max(1, Math.floor(n/2)) pegs at 1 once n=1,
  // so each side stops shrinking independently at 1. Once BOTH lists reach
  // length 1, (c.length > 1 || f.length > 1) is false and the loop exits.
  // The pathological-edge block below handles the rare 1+1 > charBudget case.
  while (prompt.length > charBudget && (c.length > 1 || f.length > 1)) {
    if (c.length > 1) c = c.slice(0, Math.max(1, Math.floor(c.length / 2)))
    if (f.length > 1) f = f.slice(0, Math.max(1, Math.floor(f.length / 2)))
    prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  }

  // Pathological edge: even 1 commit + 1 file exceeds charBudget (extremely
  // long filenames or commit messages). Drop both lists entirely.
  //
  // KNOWN RESIDUAL GAP: after dropping, the prompt still contains boilerplate
  // + tags + promptExtra ≈ 1,100 chars worst-case. If charBudget were ever set
  // below ~1,100 the returned prompt would silently exceed it. In practice the
  // minimum caller budget is MAX_PROMPT_CHARS - strictSuffix.length ≈ 11,868 —
  // far above 1,100 — so this gap is unreachable. Do NOT add a throw: a thin
  // release note is better than a hard job failure.
  if (prompt.length > charBudget) {
    c = []
    f = []
    prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  }

  return { prompt, commits: c, files: f }
}

async function run(): Promise<void> {
  try {
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.')

    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or has unexpected format (got: "${repo}")`)

    // 0. Ensure afm-cli-bin is present and up-to-date.
    //
    // ensureBinary() caches the binary at ~/.cache/runbot-hq/afm-cli-bin and
    // uses a digest sidecar for cache invalidation. On self-hosted runners
    // ~/.cache persists across jobs, so the binary is downloaded at most once
    // per runner per afm-cli release — not once per workflow run.
    // See ensureBinary() JSDoc for the full caching and auth rationale.
    core.info('[afm] Ensuring afm-cli binary...')
    const afmBin = await ensureBinary(token)
    core.info(`[afm] Binary ready: ${afmBin}`)

    try {
      fs.accessSync(afmBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `afm-cli-bin at ${afmBin} is not executable. ` +
        'This can happen if a filesystem remount, backup restore, or another tool stripped the executable bit. ' +
        'Delete the cached binary to force a re-download: ' +
        `rm -f ${afmBin} ${afmBin}.digest`
      )
    }

    // 1. Shallow clone guard
    let isShallow = false
    try {
      isShallow = git('rev-parse --is-shallow-repository') === 'true'
    } catch (e) {
      const msg = String(e).toLowerCase()
      const isNotARepo =
        msg.includes('not a git repository') ||
        msg.includes('enoent') ||
        (e instanceof Error && 'status' in e && (e as NodeJS.ErrnoException & { status?: number }).status === 128)
      if (!isNotARepo) throw new Error(`git rev-parse --is-shallow-repository failed: ${String(e)}`)
    }
    if (isShallow) {
      core.warning('Shallow clone detected — unshallowing to fetch full tag history')
      execSync('git fetch --unshallow --tags --quiet', { stdio: 'inherit' })
    }

    // 2. Resolve TAG
    let tag = core.getInput('tag').trim()
    if (!tag) {
      tag = git('tag --sort=-version:refname | head -n 1')
      if (!tag) throw new Error('No tags found in repository — cannot auto-resolve TAG.')
      core.info(`[afm] TAG not provided — auto-resolved to latest: ${tag}`)
    }
    if (tag.includes('/')) throw new Error('TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path')
    // --verify refs/tags/ is required: without it, rev-parse resolves ambiguously
    // and a branch name matching the tag input passes silently. The refs/tags/
    // prefix scopes resolution to tags only. Do NOT downgrade to rev-parse "$SAFE_TAG".
    try {
      git('rev-parse --verify "refs/tags/$SAFE_TAG"', { SAFE_TAG: tag })
    } catch {
      throw new Error(`TAG '${tag}' does not exist in this repository.`)
    }

    // 3. Resolve PREV_TAG
    let prevTag = core.getInput('prev_tag').trim()
    if (!prevTag) {
      // Channel isolation: stable tags diff only against stable tags; pre-release
      // channels (beta/alpha/rc) diff only against their own channel. This prevents
      // a stable release like 1.0 from baselining against 1.0-rc.1 and producing
      // release notes that cover only the rc-to-stable delta instead of the full
      // feature set since 0.9. Fixed originally for issue #2119 — do NOT remove.
      //
      // grep -iF -- "-$SAFE_CHANNEL": the -- separator prevents SAFE_CHANNEL
      // values that begin with - from being interpreted as grep flags.
      // -iF is case-insensitive fixed-string matching, consistent with the
      // .toLowerCase() on channelMatch[1] — both sides normalised to lowercase.
      // Do NOT replace with a regex grep — fixed-string is safer for tag names
      // that may contain regex metacharacters.
      const channelMatch = tag.match(/-(beta|alpha|rc)(?:[.-]|$)/i)
      if (channelMatch) {
        const channel = channelMatch[1].toLowerCase()
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -iF -- "-$SAFE_CHANNEL" | head -n 1',
          { SAFE_TAG: tag, SAFE_CHANNEL: channel }
        )
        if (!prevTag) {
          // No prior pre-release tag in this channel — fall back to any prior tag
          prevTag = git(
            'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | head -n 1',
            { SAFE_TAG: tag }
          )
        }
      } else {
        // Stable release: exclude all pre-release tags (beta/alpha/rc)
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -vE -- "-(beta|alpha|rc)([.-]|$)" | head -n 1',
          { SAFE_TAG: tag }
        )
      }
    }
    if (!prevTag) {
      core.warning('No previous tag found — using first commit as baseline')
      // | head -n 1 is required: repos with multiple root commits (orphan branches,
      // git replace) return multiple SHAs from rev-list --max-parents=0. Without
      // the pipe, prevTag becomes a multi-line string and the basehead API call
      // constructs "sha1\nsha2...targetTag" which returns HTTP 404.
      // Do NOT remove | head -n 1.
      prevTag = git('rev-list --max-parents=0 HEAD | head -n 1')
    }
    if (prevTag.includes('/')) throw new Error('prev_tag contains a slash — pass a plain tag name, not a ref path')

    // Validation scope: only explicitly-provided prev_tag values are validated
    // with rev-parse --verify refs/tags/.
    //
    // Auto-resolved prevTag (from git tag pipelines above) is already a known-good
    // tag name — git tag only emits tags, so no branch-name confusion is possible
    // on those paths. Validating them would be redundant.
    //
    // The first-commit fallback (rev-list --max-parents=0 above) returns a raw SHA,
    // not a tag name. That path is also auto-resolved, so it skips this block
    // entirely — correctly, since --verify refs/tags/ would reject a raw SHA.
    // The looksLikeRawSha guard below is scoped to explicit caller input only:
    // a caller could supply a raw SHA as prev_tag (valid and intentional), which
    // must also skip --verify refs/tags/ for the same reason.
    //
    // --verify refs/tags/ is required for explicit input for the same reason as
    // step 2: a branch name matching prev_tag would silently pass without it.
    if (core.getInput('prev_tag').trim()) {
      const looksLikeRawSha = /^[0-9a-f]{40,64}$/.test(prevTag)
      if (!looksLikeRawSha) {
        try {
          git('rev-parse --verify "refs/tags/$SAFE_PREV_TAG"', { SAFE_PREV_TAG: prevTag })
        } catch {
          throw new Error(`prev_tag '${prevTag}' does not exist in this repository.`)
        }
      }
    }
    core.info(`[afm] Comparing ${prevTag} → ${tag}`)

    // 4. Fetch diff context via GitHub API
    const octokit = github.getOctokit(token)
    let compare: Awaited<ReturnType<typeof octokit.rest.repos.compareCommitsWithBasehead>>
    try {
      compare = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo: repoName,
        basehead: `${prevTag}...${tag}`,
      })
    } catch (e) {
      const status = (e as { status?: number })?.status
      if (status === 403) {
        throw new Error(
          `GitHub API returned 403 when comparing ${prevTag}...${tag}. ` +
          'Ensure the calling workflow grants contents: read permission:\n' +
          '  permissions:\n' +
          '    contents: read'
        )
      }
      if (status === 404) {
        throw new Error(
          `GitHub API returned 404 when comparing ${prevTag}...${tag}. ` +
          'Ensure both refs exist and are reachable from this repository.'
        )
      }
      throw e
    }

    let commits = compare.data.commits.map(c => c.commit.message.slice(0, 120))
    let files = compare.data.files?.map(f => `${f.status} ${f.filename}`) ?? []

    const totalCommits = commits.length
    const totalFiles = files.length

    if (totalCommits > 80) core.warning(`${totalCommits} commits — prompt capped at 80`)
    if (totalFiles > 150) core.warning(`${totalFiles} files — prompt capped at 150`)

    commits = commits
      .filter(m => !/^(fixup!|squash!|[Ww][Ii][Pp]([ :]|$))/.test(m))
      .slice(0, 80)
    files = files.slice(0, 150)

    // Capture counts AFTER the WIP/fixup/squash filter AND the .slice(0,80)/slice(0,150)
    // pre-caps, but BEFORE prompt-level truncation. Named "postFilter" (not "preCapped")
    // because the filter runs before the slice — a release with 82 commits where 3 are
    // WIP-filtered would give postFilterCommitCount=79, not 80. The truncation warning
    // below uses these to show the full pipeline:
    //   totalCommits (raw API) → postFilterCommitCount (after filter+slice) → usedCommits.length (after prompt cap)
    // e.g. "commits 312 → 79 → 12" where 312→79 = filter+slice, 79→12 = prompt truncation.
    const postFilterCommitCount = commits.length
    const postFilterFileCount = files.length

    // 5. Assemble and cap prompt
    //
    // The per-list caps above (80 commits, 150 files) are not sufficient alone —
    // a release with many long commit messages can still exceed AFM's 4096-token
    // context window. truncatePromptToFit measures the assembled string and halves
    // lists until it fits MAX_PROMPT_CHARS (12_000).
    //
    // WHY promptExtra is also stripped of control chars:
    // ANSWER: safeTag and safePrevTag both apply /[\x00-\x1f\x7f]/g before being
    // embedded in the prompt. promptExtra comes from core.getInput(), which
    // passes caller-supplied workflow input through unchanged. Not a shell
    // injection risk (afmCli uses spawnSync), but control chars could corrupt
    // the prompt content or cause unexpected model behaviour. Strip applied
    // consistently with all other user-controlled strings embedded in the prompt.
    const promptExtra = core.getInput('prompt_extra').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300)
    const safeTag = tag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    const safePrevTag = prevTag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)

    // strictSuffix is defined here (before the first truncatePromptToFit call) so
    // its .length can be subtracted from the budget when building the strict-retry
    // prompt. Defined once to ensure the budget calculation and the actual append
    // always reference the same string — do NOT duplicate or edit this string
    // without updating the charBudget call in step 7.
    //
    // IMPORTANT: strictSuffix must remain pure ASCII.
    // String.prototype.length counts UTF-16 code units. For ASCII this equals
    // the char count AFM sees, keeping the charBudget math exact. Adding emoji
    // or non-ASCII here would silently miscalculate headroom. (~130 chars)
    const strictSuffix = '\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}'
    // WHY this guard exists:
    // String.prototype.length counts UTF-16 code units, not bytes or tokens.
    // For pure ASCII the count equals what AFM sees, so the charBudget
    // subtraction (MAX_PROMPT_CHARS - strictSuffix.length) is exact.
    // A non-ASCII edit (emoji, arrow, curly quote) would silently make
    // .length smaller than the actual encoded size, underestimating headroom.
    // This throws at action startup — long before any AFM call — so the
    // miscalculation is caught in CI rather than corrupting a live release.
    if (!/^[\x00-\x7f]*$/.test(strictSuffix)) {
      throw new Error('Internal error: strictSuffix contains non-ASCII characters — charBudget calculation would be incorrect. Keep strictSuffix pure ASCII.')
    }

    // usedCommits/usedFiles: post-truncation lists, used ONLY for the warning
    // and core.info lines immediately below.
    // They are NOT referenced again after this block — not in step 6, not in
    // step 7. Step 7 operates on `prompt` (a string), not on these arrays.
    const { prompt, commits: usedCommits, files: usedFiles } = truncatePromptToFit(
      safeTag, safePrevTag, commits, files, promptExtra
    )

    if (usedCommits.length < postFilterCommitCount || usedFiles.length < postFilterFileCount) {
      core.warning(
        `[afm] Prompt truncated to fit AFM context window (${MAX_PROMPT_CHARS} chars): ` +
        `commits ${totalCommits} → ${postFilterCommitCount} → ${usedCommits.length}, ` +
        `files ${totalFiles} → ${postFilterFileCount} → ${usedFiles.length}`
      )
    }
    core.info(`[afm] Prompt: ${prompt.length} chars, ${usedCommits.length} commits, ${usedFiles.length} files`)

    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'
    const afmOptions = { instructions }

    // 6. Call afm-cli
    //
    // Two distinct failure modes are handled separately:
    //
    // A. exceededContextWindowSize (context overflow) — deterministic: the same
    //    prompt will always fail regardless of how long we wait. Re-truncate to
    //    75% of the current prompt length and retry immediately. No pause needed.
    //    isContextOverflowError() matches this case.
    //
    // B. ETIMEDOUT (cold-start) — transient: the model binary is loading and needs
    //    time. Retry after a 15s warm-up pause. isFatalAfmError() does NOT match
    //    ETIMEDOUT, so it falls through to the existing cold-start path.
    //
    // Do NOT merge these two paths — they require different remediation and a
    // combined handler would either waste 15s on an overflow or skip the warm-up
    // needed for a genuine cold-start.
    core.info('[afm] Calling afm-cli...')
    let raw = ''
    try {
      raw = afmCli(afmBin, prompt, afmOptions)
    } catch (e) {
      core.debug(`[afm] Attempt 1 error: ${String(e)}`)
      if (isFatalAfmError(e)) throw e

      if (isContextOverflowError(e)) {
        // Attempt 1 overflowed the context window. Re-truncate to 75% of the
        // current prompt length and retry immediately — no pause, this is
        // deterministic. 75% (not 50%) is intentional: the overflow was marginal
        // (4,091/4,096 tokens), so a smaller reduction is usually sufficient and
        // preserves more commit context. If the re-truncated prompt still overflows
        // (very unusual — would require a further density spike), it will throw
        // and surface via core.setFailed with the overflow detail.
        core.warning(`[afm] Attempt 1 — context window overflow (${String(e).slice(0, 120)}). Re-truncating to 75% and retrying immediately...`)
        const overflowBudget = Math.floor(prompt.length * 0.75)
        const { prompt: smallerPrompt } = truncatePromptToFit(
          safeTag, safePrevTag, usedCommits, usedFiles, promptExtra, overflowBudget
        )
        core.info(`[afm] Overflow-retry prompt: ${smallerPrompt.length} chars (budget: ${overflowBudget})`)
        try {
          raw = afmCli(afmBin, smallerPrompt, afmOptions)
        } catch (e2) {
          const detail = String(e2)
          throw new Error(
            `[afm] Overflow-retry failed (binary: ${afmBin}): ${detail}. ` +
            'The re-truncated prompt still exceeded the context window or hit another error. ' +
            'Consider filing an issue with the token count from the original error.'
          )
        }
      } else {
        // Cold-start / transient error — wait 15s and retry with the original prompt.
        core.info('[afm] Attempt 1 failed — retrying in 15s (cold-start model load)...')
        await new Promise(r => setTimeout(r, 15_000))
        try {
          raw = afmCli(afmBin, prompt, afmOptions)
        } catch (e2) {
          const detail = String(e2)
          throw new Error(
            `[afm] Attempt 2 failed (binary: ${afmBin}): ${detail}. ` +
            'If this is ETIMEDOUT, the model may need more than 60s to load on first run — ' +
            'consider increasing the timeout or pre-warming the runner.'
          )
        }
      }
    }

    if (!raw) throw new Error('afm-cli returned empty output')

    // 7. Parse output — strict-prompt retry if the format is wrong.
    //
    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║  WHAT STEP 7 DOES AND DOES NOT DO — READ BEFORE RAISING A FINDING  ║
    // ╠══════════════════════════════════════════════════════════════════════╣
    // ║                                                                      ║
    // ║  DOES:     call truncatePromptToFit with a reduced charBudget        ║
    // ║            (MAX_PROMPT_CHARS - strictSuffix.length) so the suffix   ║
    // ║            is guaranteed to fit, then append strictSuffix            ║
    // ║  DOES NOT: get a 15s pause+retry loop (see WHY below)               ║
    // ║                                                                      ║
    // ║  WHY re-truncate instead of slicing after append?                   ║
    // ║  Slicing (prompt + suffix) to MAX_PROMPT_CHARS amputates the suffix ║
    // ║  whenever prompt is already at the cap — the very instruction meant  ║
    // ║  to fix malformed output gets silently dropped. Re-truncating with   ║
    // ║  a reduced budget guarantees the suffix is always present in full.   ║
    // ║                                                                      ║
    // ║  IS PASSING usedCommits/usedFiles (already-capped from step 5) OK?  ║
    // ║  Yes. They are already at or below what fits the full budget. The    ║
    // ║  ~130-char reduction rarely drops even one item; when it does, the   ║
    // ║  halving loop removes it correctly. Not a bug.                       ║
    // ║                                                                      ║
    // ║  WHY no 15s retry loop?                                             ║
    // ║  Step 7 only runs after step 6 returned output (malformed, but      ║
    // ║  returned). The model is warm — cold-start ETIMEDOUT is not the     ║
    // ║  failure mode. A warm model that returned malformed output will      ║
    // ║  not recover from a 15s pause on the same prompt.                   ║
    // ╚══════════════════════════════════════════════════════════════════════╝
    let result: { title: string; body: string }
    try {
      result = parseAfmOutput(raw, tag)
    } catch (e) {
      core.warning(`Output malformed — retrying with stricter prompt: ${e}`)
      // WHY we re-truncate with a reduced budget instead of slicing after append:
      // ANSWER: Slicing (prompt + strictSuffix) to MAX_PROMPT_CHARS would always
      // amputate the suffix for any prompt near the cap — the very instruction
      // meant to fix malformed output gets silently dropped. Instead, re-run
      // truncatePromptToFit with charBudget = MAX_PROMPT_CHARS - strictSuffix.length,
      // so the returned prompt is guaranteed to leave room for the full suffix.
      // strictSuffix is then appended unconditionally. The resulting prompt is at
      // most MAX_PROMPT_CHARS chars total — identical to the first-attempt budget.
      const { prompt: strictBase } = truncatePromptToFit(
        safeTag, safePrevTag, usedCommits, usedFiles, promptExtra,
        MAX_PROMPT_CHARS - strictSuffix.length
      )
      const strictPrompt = strictBase + strictSuffix
      core.info(`[afm] Strict-retry prompt: ${strictPrompt.length} chars (budget: ${MAX_PROMPT_CHARS - strictSuffix.length} + ${strictSuffix.length} suffix)`)
      try {
        raw = afmCli(afmBin, strictPrompt, afmOptions)
      } catch (e2) {
        const detail = String(e2)
        throw new Error(
          `[afm] Strict-prompt retry failed (binary: ${afmBin}): ${detail}. ` +
          'If this is ETIMEDOUT, the model may need more than 60s to load on first run — ' +
          'consider increasing the timeout or pre-warming the runner.'
        )
      }
      result = parseAfmOutput(raw, tag)
    }

    const { title, body } = result
    if (!title || !body) throw new Error('AFM returned empty title or body')

    // 8. Cap body length
    const finalBody = body.length > 120_000
      ? (core.warning('Generated body exceeds 120000 chars — truncating'), body.slice(0, 120_000))
      : body

    // Log release notes output to step log as a collapsible group (mirrors
    // local-ai-code-review-action PR #24) so raw output is inspectable
    // directly from the Actions UI without leaving the step log.
    //
    // Body is previewed at 2000 chars max — finalBody can be up to 120,000 chars
    // and logging it verbatim would bloat the step log with no added value over
    // the Job Summary (step 10), which already renders the full body.
    //
    // Title is sliced to 100 chars in the group label — the raw model title has
    // no length cap and an unbounded string would produce an unreadably wide
    // collapsed group header in the Actions UI.
    await core.group(`AI Release Notes Output — ${title.slice(0, 100)}`, async () => {
      const bodyPreview = finalBody.length > 2_000
        ? `${finalBody.slice(0, 2_000)}\n…(${finalBody.length} chars total — full output in Job Summary)`
        : finalBody
      core.info(`Body:\n${bodyPreview}`)
    })

    // 9. Write outputs
    core.setOutput('release_title', title)
    core.setOutput('release_body', finalBody)
    core.setOutput('prev_tag', prevTag)

    // 10. Step summary
    // safeTag / safePrevTag used here (not raw tag / prevTag) — control characters
    // are stripped so they cannot corrupt the summary markdown.
    await core.summary
      .addHeading(`📝 Release Notes: ${safeTag}`)
      .addRaw(`**Title:** ${title}\n`)
      .addRaw(`**Compared:** \`${safePrevTag}\` → \`${safeTag}\` (${totalCommits} commits, ${totalFiles} files)\n`)
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n\n`)
      .addRaw(finalBody)
      .write()

    core.info('[afm] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
