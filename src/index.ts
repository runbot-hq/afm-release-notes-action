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
  core.info(`[afm] Latest release tag