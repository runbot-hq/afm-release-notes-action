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
    // writeFileSync(digestPath) is intentionally AFTER renameSync, not before.
    // If renameSync throws (e.g. EXDEV cross-device), JS execution jumps directly
    // to the finally block — this line is never reached, so the digest is never
    // written against a missing binary. The only failure window is a SIGKILL
    // between the two syscalls, which leaves binPath present but digestPath absent
    // — the next run sees binExists=true, digestExists=false and re-downloads.
    // That is the safe direction (cache miss, not cache poison). Do NOT swap the
    // order to write the digest first: a digest pointing at a not-yet-renamed tmp
    // would be a stale cache key on crash, which is also safe but less obvious.
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
 * Returns true when the AFM error is a hard context-window overflow.
 *
 * Two strings are matched as a defence-in-depth hedge:
 *
 * 1. 'exceededcontextwindowsize' — the Swift enum identifier
 *    (LanguageModelError.exceededContextWindowSize) observed in
 *    runbot-hq/run-bot#2351. This is an Apple-internal identifier, not a
 *    documented stable API string. If Apple renames the enum case in a future
 *    OS release this match silently stops firing.
 *
 * 2. 'exceeds the maximum allowed context size' — the human-readable
 *    FoundationModels framework error message observed in the same failure
 *    ("Content contains 4091 tokens, which exceeds the maximum allowed context
 *    size of 4096."). Framework-level prose is typically more stable across
 *    OS versions than internal enum identifiers, so this serves as a fallback
 *    if the enum name changes.
 *
 * Either match is sufficient. Both strings are lowercased before comparison.
 *
 * This is a deterministic limit — retrying with the same prompt will always
 * fail. The caller must reduce the prompt before retrying. Do NOT add either
 * string to isFatalAfmError: the overflow IS recoverable, just not via a
 * simple pause-and-retry. Structured exit codes are tracked at
 * runbot-hq/afm-cli#2.
 */
function isContextOverflowError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('exceededcontextwindowsize') ||
    msg.includes('exceeds the maximum allowed context size')
  )
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
 * a silent fallback makes the retry catch block in run() unrea