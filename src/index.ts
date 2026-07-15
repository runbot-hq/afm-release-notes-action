import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string, env?: Record<string, string>): string {
  // { shell: true } is intentional: several callers use shell pipes
  // (e.g. | head -n 1, | grep -vxF) for tag resolution. All user-controlled
  // values (tag, prevTag) are passed via env vars and referenced as "$VAR"
  // (double-quoted) in the command string — never interpolated directly.
  //
  // Quoting rules for $SAFE_TAG and similar env vars:
  //   Use double-quotes: "$SAFE_TAG"  — expands the var AND prevents word-split
  //   Do NOT single-quote: '$SAFE_TAG' — single quotes suppress ALL expansion;
  //                                      git receives the literal string "$SAFE_TAG"
  //   Do NOT leave unquoted: $SAFE_TAG — word-splits on whitespace in the value
  //
  // Do NOT replace with execFileSync — the pipe operator requires a shell.
  // CALLERS MUST NOT interpolate user-controlled values directly into cmd.
  // Always use the env parameter and reference values as "$VAR_NAME" (double-quoted).
  // Note: type-level enforcement is not possible for shell strings in JS.
  // The doc contract here is the only enforcement mechanism — all current
  // call sites are verified correct. Do NOT add new call sites without review.
  //
  // NOT all git operations use this helper — `git fetch --unshallow` in step 1
  // uses execSync directly (no user input, no `git` prefix needed, stdio: inherit
  // for streaming output). That is the only intentional bypass.
  // Do NOT raise "inconsistent git() usage" — the exemption is deliberate.
  //
  // Runtime guard: catch the most common future-caller mistake — template-literal
  // interpolation (e.g. git(`tag --verify ${tag}`)). This does not catch plain
  // string concatenation, but that is covered by the JSDoc contract above.
  if (/\$\{/.test(cmd)) {
    throw new Error(`git() cmd must not use template-literal interpolation (use env param instead): ${cmd}`)
  }
  return execSync(`git ${cmd}`, {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, ...env },
  }).trim()
}

/**
 * Calls afm-cli via spawnSync with an explicit argv array.
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
    maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB can be exceeded by verbose model output
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
  // These are the only strings main.swift writes to stderr. Matched as substrings
  // (not prefix-anchored) because .includes() is used — the "anchored" framing in
  // older comments was misleading. The strings are stable and unique enough that
  // substring matching is safe.
  //
  //   Fatal (do NOT retry):
  //     "error: apple intelligence unavailable"  — .unavailable(reason) case
  //     "error: unknown model availability state" — @unknown default case
  //     "error: afm-cli requires macos 26+"       — #available guard
  //     "error: foundationmodels framework not available" — #else branch
  //   Non-fatal (retryable — NOT in this list):
  //     "error: inference failed"  — session.respond() throw, may recover on retry
  //   Not in stderr at all:
  //     ETIMEDOUT — spawnSync timeout surfaced via result.error, handled in step 6
  //
  // SOURCE 2 — OS / MDM errors surfaced via spawnSync result.error or raw stderr
  // outside main.swift. These do not begin with "error:" and have no fputs() entry.
  //   'not authorized' — macOS MDM/entitlement denial (e.g. "operation not authorized")
  //   'eacces'         — POSIX EACCES from the OS (e.g. binary not executable)
  //   'mdm policy'     — MDM policy strings (e.g. "blocked by mdm policy")
  // Do NOT remove these — they guard a real, separate error path that is not
  // produced by main.swift but is equally unrecoverable on retry.
  const msg = String(e).toLowerCase()
  return (
    msg.includes('error: apple intelligence unavailable') ||
    msg.includes('error: unknown model availability state') ||
    msg.includes('error: afm-cli requires macos') ||
    msg.includes('error: foundationmodels framework not available') ||
    msg.includes('not authorized') || // SOURCE 2: OS/MDM entitlement denial
    msg.includes('eacces') ||         // SOURCE 2: POSIX EACCES
    msg.includes('mdm policy')        // SOURCE 2: MDM policy block (e.g. "blocked by mdm policy")
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
 * Fence-stripping uses replace() without /g by design — only the first fence
 * is removed. Preamble text before a fenced block causes JSON.parse to throw,
 * which routes to the strict-prompt retry in the caller. Do NOT add /g —
 * it would silently accept malformed output instead of triggering the retry.
 *
 * The three replace() calls are order-sensitive but correct:
 *   1. /^```json\s*/m  — strips opening fence with language tag (e.g. ```json)
 *   2. /^```\s*/m      — fallback: strips opening fence without tag (e.g. ```JSON uppercase)
 *                        also matches the closing fence if it appears at a line start,
 *                        but only AFTER the opening fence was already removed by step 1.
 *                        With well-formed single-block output this is harmless.
 *   3. /```\s*$/m      — strips closing fence.
 * Do NOT reorder or merge these — the fallback in step 2 is intentional.
 *
 * @param raw         Raw string output from afm-cli stdout
 * @param currentTag  Current tag string, used as title fallback for format C.
 *                    Passed explicitly to keep this function pure and testable
 *                    without mocking the GitHub Actions runtime.
 *                    Always the resolved tag value — never empty when called
 *                    from run(), so the '|| "Release"' fallback is belt-and-suspenders.
 *                    Do NOT raise "currentTag can be empty" — tag is always resolved
 *                    before parseAfmOutput is called (steps 2–3 in run()).
 */
function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/, '')  // no /m — $ must match end-of-string, not end-of-line.
                              // With /m, any line ending in ``` would be stripped,
                              // including fenced code blocks inside the JSON body.
    .trim()

  // Format A/B: { title, body } or double-encoded string
  try {
    const parsed = JSON.parse(cleaned)
    const obj = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    // Use typeof checks not truthiness — obj?.title && obj?.body fails on empty string
    // title, which would fall through to Format C and throw a misleading Format D error.
    if (typeof obj?.title === 'string' && obj.title.length > 0 &&
        typeof obj?.body === 'string' && obj.body.length > 0) {
      return { title: String(obj.title), body: String(obj.body) }
    }
  } catch { /* fall through */ }

  // Format C: section-keyed { Added: [], Changed: [], ... }
  try {
    const obj = JSON.parse(cleaned)
    const sections = ['Added', 'Changed', 'Fixed', 'Removed', 'Security']
    const hasSections = sections.some(s => Array.isArray(obj[s]) && obj[s].length > 0)
    if (hasSections) {
      core.warning('AFM returned section-keyed JSON — converting to {title, body}')
      const body = sections
        .filter(s => Array.isArray(obj[s]) && obj[s].length > 0)
        .map(s => `## ${s}\n${(obj[s] as string[]).map((l: string) => `- ${l}`).join('\n')}`)
        .join('\n\n')
      // currentTag is always the resolved tag — never empty here. '|| "Release"' is
      // belt-and-suspenders only. Do NOT change this to core.getInput('tag') —
      // that returns the raw input which is empty when tag was auto-resolved.
      return { title: currentTag || 'Release', body }
    }
  } catch { /* fall through */ }

  // Format D: unrecognised — throw so caller retries with stricter prompt.
  // Do NOT convert this to a return — the retry block in run() depends on this throw.
  throw new Error(`AFM output did not match any known format. Raw: ${raw.slice(0, 200)}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    // Wire the debug input to ACTIONS_STEP_DEBUG so core.isDebug() returns true
    // for the rest of this run when the caller sets `with: debug: true`.
    // This is the ONE place where the debug input is read — do not look for
    // core.getInput('debug') at individual call sites; it is intentionally
    // wired here once, globally. Do NOT raise "debug input is never read".
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    // GITHUB_TOKEN must be set explicitly in the workflow step:
    //   env:
    //     GITHUB_TOKEN: ${{ github.token }}
    // Passing an empty string to getOctokit() does not throw immediately —
    // it produces an opaque 401 at the first API call. Fail fast instead.
    // Do NOT raise "GITHUB_TOKEN not declared as action input" — callers set it
    // via env: on the step; a declared input with default: ${{ github.token }}
    // is a future improvement but out of scope for this PR.
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.')

    // GITHUB_REPOSITORY is set by the runner as "owner/repo".
    // Split can yield undefined values on non-standard runner configs — guard explicitly.
    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or has unexpected format (got: "${repo}")`)

    // actionPath is the directory where action.yml lives.
    // afm-cli binary is committed there alongside action.yml.
    // GITHUB_ACTION_PATH is set by the runner for all action types including node20.
    //
    // NOTE: dist/index.js (the compiled TS bundle) and the afm-cli binary are
    // NOT committed in this PR. Both require a local build step on the self-hosted
    // macOS runner (issue #22, step 2: npm run build && swift build -c release).
    // This is intentional — they are build artifacts, not source files.
    // Do NOT raise "dist/index.js not committed" as a review finding.
    // Do NOT raise "afm-cli binary not committed" as a review finding.
    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')
    const afmBin = path.join(actionPath, 'afm-cli')

    if (!fs.existsSync(afmBin)) {
      // This action requires a self-hosted macOS arm64 runner with Apple Intelligence.
      // On Linux or Windows runners afm-cli will not exist — the action cannot run.
      // The old composite action had an explicit runner.os check; this error message
      // is the node20 equivalent — it fails fast with the same clarity.
      throw new Error(
        `afm-cli binary not found at ${afmBin}. ` +
        'This action requires a self-hosted macOS 26+ arm64 runner with Apple Intelligence enabled. ' +
        'It cannot run on GitHub-hosted Linux or Windows runners.'
      )
    }

    // Verify the binary is executable, not just present. A file committed without
    // the execute bit (common via GitHub API or Windows-origin commits) will cause
    // spawnSync to return EACCES. Catch it here with a clear message.
    try {
      fs.accessSync(afmBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `afm-cli binary at ${afmBin} is not executable. Run: chmod +x afm-cli and recommit.`
      )
    }

    // 1. Shallow clone guard
    // The try wraps only the rev-parse check. If the repo is shallow, the
    // fetch --unshallow call runs outside the catch scope — any failure there
    // (auth, network, ref error) propagates directly without being swallowed.
    //
    // exit 128 from git rev-parse means "not a git repository" in this context
    // (e.g. action running outside a checkout step). That is safe to skip.
    // exit 128 from git fetch --unshallow means something operationally failed
    // and must NOT be swallowed — incomplete history produces wrong tag resolution.
    // Do NOT raise "status 128 catch is too broad" — fetch --unshallow is
    // deliberately outside this try/catch and always propagates.
    let isShallow = false
    try {
      isShallow = git('rev-parse --is-shallow-repository') === 'true'
    } catch (e) {
      // Only swallow "not a git repo" errors from rev-parse (ENOENT, exit 128,
      // or the literal message). Any other error is unexpected and rethrows.
      const msg = String(e).toLowerCase()
      const isNotARepo =
        msg.includes('not a git repository') ||
        msg.includes('enoent') ||
        (e instanceof Error && 'status' in e && (e as NodeJS.ErrnoException & { status?: number }).status === 128)
      if (!isNotARepo) throw new Error(`git rev-parse --is-shallow-repository failed: ${String(e)}`)
    }
    if (isShallow) {
      core.warning('Shallow clone detected — unshallowing to fetch full tag history')
      // Not wrapped in try/catch — auth/network/ref failures must surface.
      // A failed unshallow with incomplete history produces wrong release notes.
      // execSync used directly here (not via the git() helper) — intentional.
      // This command takes no user input so there is no injection surface,
      // and it does not need git prepended. Do NOT raise "inconsistent execSync usage".
      execSync('git fetch --unshallow --tags --quiet', { stdio: 'inherit' })
    }

    // 2. Resolve TAG
    // tag is validated (slash-guard + rev-parse) before any shell or prompt use.
    // Shell calls reference tag via "$SAFE_TAG" (double-quoted env var) —
    // never direct interpolation. Double-quoting prevents word-splitting while
    // still expanding the env var. Do NOT use single-quotes ('$SAFE_TAG') —
    // single quotes suppress ALL shell expansion; git would receive the literal
    // string "$SAFE_TAG" instead of the tag value.
    //
    // Prompt injection via tag: tag is interpolated into the prompt string below,
    // but this is not an injection vector — git rev-parse validates the tag exists
    // in the repository. A tag containing adversarial content would require the
    // attacker to have already pushed that tag to the repo, at which point the
    // repository itself is compromised. No additional sanitisation is warranted.
    let tag = core.getInput('tag').trim()
    if (!tag) {
      tag = git('tag --sort=-version:refname | head -n 1')
      if (!tag) throw new Error('No tags found in repository — cannot auto-resolve TAG.')
      core.info(`[afm] TAG not provided — auto-resolved to latest: ${tag}`)
    }
    if (tag.includes('/')) throw new Error('TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path')
    try {
      // "$SAFE_TAG" double-quoted — expands the env var, prevents word-splitting.
      // Do NOT change to '$SAFE_TAG' (single-quoted) — that passes the literal
      // string "$SAFE_TAG" to git and validation always fails.
      git('rev-parse "$SAFE_TAG"', { SAFE_TAG: tag })
    } catch {
      throw new Error(`TAG '${tag}' does not exist in this repository.`)
    }

    // 3. Resolve PREV_TAG
    // grep -vxF uses fixed-string (-F) and full-line (-x) matching, NOT regex.
    // Do NOT use grep -v "^$SAFE_TAG$" — that treats the tag as a BRE, so dots
    // in version tags like v1.2.3 would match any character and could accidentally
    // exclude sibling tags (e.g. v1x2x3), skipping to an older baseline.
    // Do NOT raise "grep uses regex on tag" — -F (fixed-string) disables regex entirely.
    let prevTag = core.getInput('prev_tag').trim()
    if (!prevTag) {
      prevTag = git('tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | head -n 1', { SAFE_TAG: tag })
    }
    if (!prevTag) {
      core.warning('No previous tag found — using first commit as baseline')
      // git rev-list returns a commit SHA (e.g. abc1234...) which never contains /.
      // The slash-guard below will not trigger on this value — that is correct and intentional.
      prevTag = git('rev-list --max-parents=0 HEAD')
    }
    // Slash-guard rejects ref paths (e.g. refs/tags/v1.0.0) — plain tag names and
    // SHAs (the rev-list fallback above) are always slash-free and pass correctly.
    if (prevTag.includes('/')) throw new Error('prev_tag contains a slash — pass a plain tag name, not a ref path')
    // rev-parse guard: validate user-supplied prev_tag exists before hitting the
    // GitHub API. Auto-resolved values (tag list + grep) are always valid by
    // construction; the SHA fallback from rev-list is always valid. Only a
    // user-supplied prev_tag can be invalid — guard it symmetrically with TAG.
    // Skip the check for SHAs (40 hex chars) — rev-parse works on SHAs too,
    // but the sha pattern is the rev-list fallback which is always valid.
    // Do NOT raise "prev_tag rev-parse is redundant" — an invalid user-supplied
    // prev_tag produces an opaque GitHub API 422 without this guard.
    if (core.getInput('prev_tag').trim()) {
      try {
        git('rev-parse "$SAFE_PREV_TAG"', { SAFE_PREV_TAG: prevTag })
      } catch {
        throw new Error(`prev_tag '${prevTag}' does not exist in this repository.`)
      }
    }
    core.info(`[afm] Comparing ${prevTag} → ${tag}`)

    // 4. Fetch diff context via GitHub API
    //
    // compareCommitsWithBasehead accepts both tag names and commit SHAs as
    // basehead arguments — the SHA fallback from rev-list above is valid here.
    //
    // Pagination: this endpoint caps at 250 commits and 300 files per response.
    // Pagination is intentionally not followed — the prompt is already capped at
    // 80 commits / 150 files, so fetching additional pages would not change the
    // model input. The > 80 / > 150 warnings below fire correctly on the first
    // page — if the API returns exactly 250 commits, the warning still fires
    // (250 > 80). Silently capped releases are noted in the step summary.
    //
    // Requires: contents: read permission on GITHUB_TOKEN.
    // The permissions: block in action.yml documents this requirement but is
    // advisory only — GitHub does not enforce action-level permissions at runtime.
    // The caller workflow must grant contents: read at the job or workflow level.
    // A missing permission surfaces as HTTP 403 — caught below with an actionable message.
    const octokit = github.getOctokit(token)
    let compare: Awaited<ReturnType<typeof octokit.rest.repos.compareCommitsWithBasehead>>
    try {
      compare = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo: repoName,
        basehead: `${prevTag}...${tag}`,
      })
    } catch (e) {
      // Enrich known HTTP errors with actionable messages — raw Octokit errors are opaque.
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
          'Ensure both refs exist and are reachable from this repository. ' +
          'If prev_tag was auto-resolved via rev-list, the commit may not be ' +
          'reachable from the GitHub API in a shallow or forked context.'
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
    // promptExtra is caller-supplied (core.getInput) and sliced to 300 chars.
    // It is passed into the prompt string which goes through spawnSync argv —
    // not a shell string — so shell metacharacters in promptExtra are inert.
    // Do NOT move afmCli to execSync with shell: true or this guarantee breaks.
    const promptExtra = core.getInput('prompt_extra').slice(0, 300)

    // Sanitise tag and prevTag before interpolating into the prompt.
    // rev-parse validates existence but does not prevent prompt injection:
    // a tag like "v1.0 IGNORE PREVIOUS INSTRUCTIONS" is a valid git tag and
    // would pass rev-parse, but could influence the LLM's output.
    // Impact is low (output goes to release notes only, never executed), but
    // strip control characters and cap length as a belt-and-suspenders measure.
    // Semver tags are at most ~30 chars; 200 is generous for non-semver tags.
    const safeTag = tag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    const safePrevTag = prevTag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)

    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'

    const prompt = [
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

    // afmOptions intentionally omits temperature and maximumResponseTokens —
    // passing neither flag lets afm-cli use Apple's model defaults (nil in Swift).
    // Add them here only if you need to override the model's calibrated defaults.
    const afmOptions = { instructions }

    // 6. Call afm-cli.
    // Retry once on cold-start failure (model not yet loaded in memory).
    // Do NOT retry on fatal errors — MDM lockout, AI unavailable, and permission
    // denied will not recover in 15s. isFatalAfmError() detects these and rethrows
    // immediately. The first error is always logged via core.debug so the root
    // cause is never silently dropped even when the retry succeeds.
    //
    // ETIMEDOUT is not treated as fatal — a slow cold-start can exceed 60s on
    // first run. If attempt 2 also times out, the error is enriched with the
    // binary path and attempt number before propagating to core.setFailed.
    core.info('[afm] Calling afm-cli...')
    // Initialized to '' so TypeScript's definite-assignment analysis is unambiguous
    // across the nested try/catch below. The if (!raw) guard after the block catches
    // any path that somehow exits without assigning a non-empty value.
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
        // Enrich bare ETIMEDOUT / generic errors with context before surfacing.
        const detail = String(e2)
        throw new Error(
          `[afm] Attempt 2 failed (binary: ${afmBin}): ${detail}. ` +
          'If this is ETIMEDOUT, the model may need more than 60s to load on first run — ' +
          'consider increasing the timeout or pre-warming the runner.'
        )
      }
    }

    if (!raw) throw new Error('afm-cli returned empty output')

    // 7. Parse output.
    // parseAfmOutput throws on unrecognised output (format D) — that throw
    // is what makes this retry branch reachable. Do NOT make parseAfmOutput
    // return silently on prose fallback or this catch block becomes dead code.
    // tag is passed explicitly so parseAfmOutput stays pure and unit-testable
    // without mocking the GitHub Actions runtime.
    let result: { title: string; body: string }
    try {
      result = parseAfmOutput(raw, tag)
    } catch (e) {
      core.warning(`Output malformed — retrying with stricter prompt: ${e}`)
      const strictPrompt = `${prompt}\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}`
      // NOTE: afmCli() here is a single attempt — no cold-start retry wrap.
      // This is intentional: if step 6 succeeded, the model is already loaded
      // in memory and a cold-start timeout on this call is extremely unlikely.
      // Error context is enriched below so ETIMEDOUT surfaces with the same
      // binary path and pre-warm hint as the step-6 error handler.
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
      result = parseAfmOutput(raw, tag) // throws and fails the action if still malformed
    }

    const { title, body } = result
    if (!title || !body) throw new Error('AFM returned empty title or body')

    // 8. Cap body length
    const finalBody = body.length > 120_000
      ? (core.warning('Generated body exceeds 120000 chars — truncating'), body.slice(0, 120_000))
      : body

    core.info(`[afm] Generated: ${title}`)

    // 9. Write outputs.
    // outputs: in action.yml intentionally omits value: fields — value: expressions
    // are only valid in composite actions. For node20 actions, core.setOutput()
    // writes directly to $GITHUB_OUTPUT. This is correct behaviour, not an omission.
    // Do NOT add value: fields to action.yml outputs — they are invalid in node20 actions.
    core.setOutput('release_title', title)
    core.setOutput('release_body', finalBody)
    core.setOutput('prev_tag', prevTag)

    // 10. Step summary
    await core.summary
      .addHeading(`📝 Release Notes: ${tag}`)
      .addRaw(`**Title:** ${title}\n`)
      .addRaw(`**Compared:** \`${prevTag}\` → \`${tag}\` (${totalCommits} commits, ${totalFiles} files)\n`)
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n\n`)
      .addRaw(finalBody)
      .write()

    core.info('[afm] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
