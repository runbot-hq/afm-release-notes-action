import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync, execFileSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
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

/**
 * Downloads afm-cli-bin from runbot-hq/afm-cli latest release into RUNNER_TEMP
 * using curl (universally available on macOS — no extra runner dependencies).
 *
 * execFileSync is used deliberately — args are a plain array passed directly
 * to the OS, no shell involved, no injection risk from the URL constant.
 * Do NOT refactor to execSync with a shell string.
 *
 * The binary is written to RUNNER_TEMP (not the workspace) so it is:
 *   - Cleaned up automatically after the job
 *   - Not committed or staged into the caller's repo checkout
 *   - Shared across steps in the same job if needed
 * RUNNER_TEMP is per-job in GitHub Actions — it does NOT persist across jobs.
 * Within a job it persists across steps, which is the intended sharing scope.
 *
 * releases/latest tradeoff: the URL resolves to whatever is currently the
 * latest release at runbot-hq/afm-cli — no SHA pinning, no checksum
 * verification. This is a conscious architectural tradeoff accepted because:
 *   - runbot-hq controls both this repo and afm-cli (same org, same trust boundary)
 *   - curl --fail will catch 404 / HTTP errors and exit non-zero
 *   - The self-hosted runner has no internet exposure beyond GitHub
 * For callers requiring a pinned version, add an afm_cli_version input and
 * substitute it into the URL.
 * TODO: publish a companion .sha256 file from the afm-cli release pipeline and
 * verify it here with shasum -a 256 -c. This closes the supply-chain timing
 * window where a compromised or broken release published after a caller pins
 * @v1 would be silently downloaded on the next run. Tracked as a follow-up.
 *
 * --retry 3 --retry-delay 2: retries up to 3 times on transient network errors
 * (TCP reset, CDN hiccup on the GitHub releases redirect chain). curl --fail
 * still exits non-zero on HTTP 4xx/5xx — --retry does not retry those.
 * If all retries fail, execFileSync throws and the partial file (if any) is
 * cleaned up by the caller before propagating the error.
 */
function downloadAfmCli(dest: string): void {
  core.info('[afm] Downloading afm-cli-bin from runbot-hq/afm-cli latest release...')
  try {
    execFileSync('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry', '3',
      '--retry-delay', '2',
      'https://github.com/runbot-hq/afm-cli/releases/latest/download/afm-cli-bin',
      '--output', dest,
    ])
  } catch (e) {
    // Clean up any partial file curl may have written before throwing.
    // Without this, a re-run of the same job step finds fs.existsSync(dest)
    // true, skips the download, then fails at fs.accessSync(X_OK) with a
    // confusing "unexpected — please file a bug" message instead of retrying.
    try { fs.unlinkSync(dest) } catch { /* ignore — file may not exist */ }
    throw e
  }
  fs.chmodSync(dest, 0o755)
  core.info(`[afm] Downloaded afm-cli-bin to ${dest}`)
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
  //   'not authorized' — macOS MDM/entitlement denial
  //   'eacces'         — POSIX EACCES from the OS
  //   'mdm policy'     — MDM policy strings
  const msg = String(e).toLowerCase()
  return (
    msg.includes('error: apple intelligence unavailable') ||
    msg.includes('error: unknown model availability state') ||
    msg.includes('error: afm-cli requires macos') ||
    msg.includes('error: foundationmodels framework not available') ||
    msg.includes('not authorized') ||
    msg.includes('eacces') ||
    msg.includes('mdm policy')
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
 * Sentinel: PARSE_FAILED is a dedicated Symbol used as the initial value of
 * `parsed`. This distinguishes a JSON.parse failure (catch leaves parsed as
 * PARSE_FAILED) from a successful parse that returned the JS value null
 * (JSON.parse("null") === null, which is valid JSON). Using null as a sentinel
 * conflates these two cases. With the Symbol: a catch leaves parsed ===
 * PARSE_FAILED → skip format dispatch. JSON.parse("null") sets parsed = null
 * → enters format dispatch → falls through all format checks → throws the
 * unrecognised-format error → strict-prompt retry fires.
 * Do NOT revert to `parsed = null` as the catch sentinel.
 *
 * Format C element coercion: obj[s] is cast via String(l) rather than a
 * `l: string` type annotation. Array.isArray guards array presence but not
 * element types — a model returning { "Added": [1, 2, 3] } passes the guard
 * and the type annotation silently accepts numbers. String() coercion makes
 * the output correct regardless of element type. Do NOT revert to `l: string`.
 */
function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')  // /m required — $ must anchor to end-of-line, not end-of-string
    .trim()

  // PARSE_FAILED is a dedicated sentinel so JSON.parse("null") (valid JSON,
  // returns JS null) is not conflated with a parse failure.
  // Do NOT revert to `parsed = null` — see JSDoc above.
  const PARSE_FAILED = Symbol('PARSE_FAILED')
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// MAX_PROMPT_CHARS: hard cap on the total prompt character count before sending
// to AFM. AFM's context window is ~4096 tokens ≈ 16 000 chars (4 chars/token
// estimate). The per-list caps (80 commits × 120 chars + 150 files) can produce
// ~13 000+ chars of list content alone before boilerplate is added. Without
// this cap, a large-changeset run would fail at inference time with
// exceededContextWindowSize. The strict-prompt retry would then fire with an
// equally oversized prompt and also fail — producing an unactionable retry loop.
//
// Truncation snaps to the last newline boundary — never mid-line. This preserves
// structural coherence: the Rules: block and JSON format instruction are always
// complete because they appear at the top of the prompt, well before the list
// content that is the likely truncation zone. A raw slice(0, N) risks cutting
// inside a commit message or, worse, inside the Rules: block if tags/prompt_extra
// are unusually long. Snapping to \n ensures every line sent to AFM is whole.
// Do NOT revert to a raw slice without the lastIndexOf boundary.
//
// 13 500 chars is conservative; raise if AFM raises its context window.
// Do NOT remove this guard without replacing it.
const MAX_PROMPT_CHARS = 13_500

async function run(): Promise<void> {
  try {
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.')

    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or has unexpected format (got: "${repo}")`)

    // afm-cli-bin is downloaded at runtime from runbot-hq/afm-cli latest release
    // via curl into RUNNER_TEMP. curl ships with macOS as part of the OS —
    // no extra runner dependencies. RUNNER_TEMP is cleaned up after the job.
    // See downloadAfmCli() JSDoc for the releases/latest tradeoff rationale.
    const afmBin = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'afm-cli-bin')

    if (!fs.existsSync(afmBin)) {
      downloadAfmCli(afmBin)
    } else {
      core.info(`[afm] afm-cli-bin already present at ${afmBin}, skipping download`)
    }

    try {
      fs.accessSync(afmBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `afm-cli-bin at ${afmBin} is not executable. This is unexpected after download — please file a bug.`
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

    // 5. Build prompt
    const rawPromptExtra = core.getInput('prompt_extra')
    if (rawPromptExtra.length > 300) {
      core.warning(
        `prompt_extra is ${rawPromptExtra.length} chars — truncated to 300. ` +
        'Shorten your extra instruction to avoid silent truncation.'
      )
    }
    const promptExtra = rawPromptExtra.slice(0, 300)
    const safeTag = tag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    const safePrevTag = prevTag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)

    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'

    const promptLines = [
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
    ]

    let prompt = promptLines.join('\n')

    // Enforce MAX_PROMPT_CHARS to prevent exceededContextWindowSize at inference.
    // Snap to the last newline boundary — never slice mid-line. A raw
    // slice(0, MAX_PROMPT_CHARS) risks cutting inside a commit message or,
    // in the worst case, inside the Rules: block if safeTag/safePrevTag are
    // long (up to 200 chars each). Snapping to \n ensures every line sent to
    // AFM is structurally whole. The fallback `|| sliced` handles the degenerate
    // case where the entire prompt has no newlines (should not happen in practice).
    // Do NOT revert to a raw slice without the lastIndexOf boundary.
    //
    // originalLength is captured before truncation so the warning can report
    // the original size without re-joining promptLines (which would allocate
    // a second full copy of the string).
    if (prompt.length > MAX_PROMPT_CHARS) {
      const originalLength = prompt.length
      const sliced = prompt.slice(0, MAX_PROMPT_CHARS)
      prompt = sliced.slice(0, sliced.lastIndexOf('\n') + 1).trimEnd() || sliced
      core.warning(
        `Prompt is ${originalLength} chars — truncated to ${prompt.length} chars at a line boundary to fit AFM context window. ` +
        'Some commits or files may be omitted from the generated notes.'
      )
    }

    const afmOptions = { instructions }

    // 6. Call afm-cli
    core.info('[afm] Calling afm-cli...')
    let raw = ''
    try {
      raw = afmCli(afmBin, prompt, afmOptions)
    } catch (e) {
      core.debug(`[afm] Attempt 1 error: ${String(e)}`)
      if (isFatalAfmError(e)) throw e
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

    if (!raw) throw new Error('afm-cli returned empty output')

    // 7. Parse output
    let result: { title: string; body: string }
    try {
      result = parseAfmOutput(raw, tag)
    } catch (e) {
      core.warning(`Output malformed — retrying with stricter prompt: ${e}`)
      const strictPrompt = `${prompt}\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}`
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
      // If parseAfmOutput throws here, the error propagates to the outer catch
      // and surfaces via core.setFailed. This is intentional — two consecutive
      // parse failures indicate the model is not following the format instruction
      // and a third attempt is unlikely to succeed.
      result = parseAfmOutput(raw, tag)
    }

    const { title, body } = result
    if (!title || !body) throw new Error('AFM returned empty title or body')

    // 8. Cap body length
    const finalBody = body.length > 120_000
      ? (core.warning('Generated body exceeds 120000 chars — truncating'), body.slice(0, 120_000))
      : body

    core.info(`[afm] Generated: ${title}`)

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
