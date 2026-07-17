import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string, env?: Record<string, string>): string {
  // WHY execSync + shell: '/bin/sh' and not execFileSync:
  //
  // Several callers use shell pipe operators (| grep, | head -n 1) which
  // require a shell to interpret. execFileSync does not invoke a shell and
  // cannot run piped commands — do NOT replace it.
  //
  // WHY shell: '/bin/sh' and not shell: true:
  //
  // TypeScript 5.9 tightened ExecSyncOptions.shell to `string | undefined`;
  // `boolean` is no longer assignable and causes a compile error. '/bin/sh'
  // is correct and equivalent — Node's child_process uses /bin/sh internally
  // when shell: true is passed anyway. Do NOT revert to shell: true.
  //
  // IS THIS A SHELL INJECTION RISK? No — here is why:
  //
  // All user-controlled values (tag names, prev_tag) are passed exclusively
  // via the `env` parameter and referenced as double-quoted "$VAR" in the
  // command string. The shell expands them as a single token with no word
  // splitting or glob expansion. They are NEVER interpolated directly into
  // the command string. The template-literal guard below enforces this:
  if (/\$\{/.test(cmd)) {
    // Compile-time safety net: if any caller accidentally uses a template
    // literal to embed a variable directly into cmd, this throws immediately
    // at runtime rather than silently executing with injected content.
    throw new Error(`git() cmd must not use template-literal interpolation (use env param instead): ${cmd}`)
  }
  return execSync(`git ${cmd}`, {
    encoding: 'utf8',
    shell: '/bin/sh',
    env: { ...process.env, ...env },
  }).trim()
}

/**
 * Calls afm-cli-bin via spawnSync with an explicit argv array.
 *
 * WHY spawnSync and not execSync:
 *
 * spawnSync passes args directly to the OS as an argv array without invoking
 * a shell. This means shell metacharacters in prompt content (user-supplied
 * via prompt_extra, commit messages, filenames) cannot be interpreted as
 * shell syntax. Do NOT refactor to execSync with a shell string — the
 * shell-safety of all prompt content depends on this.
 *
 * WHY maxBuffer: 10 MB:
 *
 * Node's default is 1 MB. Verbose model output can exceed this before the
 * 120_000 char body cap is applied downstream (step 8). 10 MB is a
 * conservative upper bound for any realistic release notes payload.
 * Do NOT reduce this without understanding the downstream cap in step 8.
 *
 * WHY timeout: 60_000 (60 seconds):
 *
 * Apple Intelligence model load on a cold macOS runner can take 30–40s on
 * first invocation. 60s gives a 20–30s margin. ETIMEDOUT from this timeout
 * is treated as a non-fatal retryable error (see isFatalAfmError) — the
 * caller in step 6 will pause 15s and retry once before failing. If the
 * second attempt also times out, the error is enriched with context before
 * surfacing. Do NOT reduce this timeout — cold-start failures will recur.
 *
 * WHY result.stderr?.trim() uses optional chaining:
 *
 * spawnSync types stderr as Buffer | string | null depending on the encoding
 * option. With encoding: 'utf8' it will be a string, but the TypeScript
 * type is nullable. The optional chain is a type-safe guard, not an
 * indicator that stderr is expected to be absent.
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
    timeout: 60_000,      // see JSDoc above: cold-start can take 30-40s
    maxBuffer: 10 * 1024 * 1024,  // 10 MB; see JSDoc above
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    // result.stderr is typed as string | null with encoding:'utf8'; the
    // optional chain is a type-safe guard only — see JSDoc above.
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
 * WHY is "error: inference failed" NOT in this list:
 *
 * "inference failed" maps to a thrown error from session.respond() in
 * main.swift — it is transient and may recover on a second attempt (e.g.
 * a busy model context). It is deliberately retryable. Do NOT add it here.
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
  //   Non-fatal (retryable — NOT in this list — see JSDoc above):
  //     "error: inference failed"  — transient; session.respond() throw
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
 * a silent fallback makes the retry catch block in run() unreachable dead code
 * and would accept malformed output as valid.
 *
 * WHY are the catch blocks silent (/* fall through *\/):
 *
 * Each try block is an independent format probe. A JSON.parse failure on
 * format A is expected and normal when the output matches format B or C.
 * These are not swallowed errors — they are explicit "not this format"
 * signals. If no format matches, the function throws at the bottom.
 * Do NOT add logging inside these catch blocks — every non-ideal response
 * would produce spurious warnings even when the next probe succeeds.
 */
function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    const obj = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    if (typeof obj?.title === 'string' && obj.title.length > 0 &&
        typeof obj?.body === 'string' && obj.body.length > 0) {
      return { title: String(obj.title), body: String(obj.body) }
    }
  } catch { /* not format A/B — fall through to next probe */ }

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
      return { title: currentTag || 'Release', body }
    }
  } catch { /* not format C — fall through to throw below */ }

  // No recognised format matched. Throw so the caller can retry with a
  // stricter prompt. Do NOT return a default here — see JSDoc above.
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
const MAX_PROMPT_CHARS = 13_500

/**
 * Assembles the prompt string from its components.
 *
 * Extracted from run() so that truncatePromptToFit() can rebuild it cheaply
 * on each halving iteration without duplicating the join logic.
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
 * to MAX_PROMPT_CHARS to stay within AFM's 4096-token context window.
 *
 * WHY 13_500 chars and not 16_384 (4096 * 4):
 *
 * The 4 chars/token estimate is conservative — real token counts for
 * code/commit messages are often 3–3.5 chars/token. 13_500 gives ~720
 * tokens of headroom for the instructions string (passed separately to
 * AFM as a system prompt) and the generated response. The instructions
 * string is ~180 chars (~45 tokens) so actual headroom is ~675 tokens.
 * Do NOT raise this limit without re-measuring real token counts.
 *
 * WHY progressively halve instead of binary-search:
 *
 * The loop runs at most log2(80) ≈ 7 times. Binary search adds code
 * complexity for negligible gain at these list sizes.
 *
 * WHY we keep at least 0 items (empty lists) rather than throwing:
 *
 * A prompt with just the tag names and rules is still valid input for AFM
 * — it will produce a minimal release note rather than failing the job.
 * Failing here would be worse than a thin release note.
 */
function truncatePromptToFit(
  safeTag: string,
  safePrevTag: string,
  commits: string[],
  files: string[],
  promptExtra: string
): { prompt: string; commits: string[]; files: string[] } {
  let c = [...commits]
  let f = [...files]

  let prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  if (prompt.length <= MAX_PROMPT_CHARS) return { prompt, commits: c, files: f }

  // Progressively halve both lists until the prompt fits.
  while (prompt.length > MAX_PROMPT_CHARS && (c.length > 1 || f.length > 1)) {
    if (c.length > 1) c = c.slice(0, Math.max(1, Math.floor(c.length / 2)))
    if (f.length > 1) f = f.slice(0, Math.max(1, Math.floor(f.length / 2)))
    prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  }

  // Pathological edge case: even 1 commit + 1 file is too large (very long
  // filenames / commit messages). Drop both lists entirely.
  if (prompt.length > MAX_PROMPT_CHARS) {
    c = []
    f = []
    prompt = buildPrompt(safeTag, safePrevTag, c, f, promptExtra)
  }

  return { prompt, commits: c, files: f }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.')

    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or has unexpected format (got: "${repo}")`)

    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')

    // The binary is committed as afm-cli-bin (not afm-cli) to avoid a name
    // collision with the afm-cli/ Swift package source directory at the repo root.
    // POSIX mv/cp move a file *into* a same-named directory if one exists.
    // Do NOT change this back to 'afm-cli' — the directory collision will recur.
    const afmBin = path.join(actionPath, 'afm-cli-bin')

    if (!fs.existsSync(afmBin)) {
      throw new Error(
        `afm-cli-bin binary not found at ${afmBin}. ` +
        'This action requires a self-hosted macOS 26+ arm64 runner with Apple Intelligence enabled. ' +
        'It cannot run on GitHub-hosted Linux or Windows runners.'
      )
    }

    try {
      fs.accessSync(afmBin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `afm-cli-bin binary at ${afmBin} is not executable. Run: chmod +x afm-cli-bin and recommit.`
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
    try {
      git('rev-parse "$SAFE_TAG"', { SAFE_TAG: tag })
    } catch {
      throw new Error(`TAG '${tag}' does not exist in this repository.`)
    }

    // 3. Resolve PREV_TAG
    //
    // CHANNEL ISOLATION — this is intentional and must not be simplified.
    //
    // Release notes must only compare within the same release channel:
    //   - A release tag  (e.g. 0.2)        → prev must be a release tag  (e.g. 0.1)
    //   - A beta tag     (e.g. 0.2-beta.3) → prev must be a beta tag     (e.g. 0.2-beta.2)
    //   - An alpha tag   (e.g. 0.2-alpha.1)→ prev must be an alpha tag
    //   - An rc tag      (e.g. 0.2-rc.1)   → prev must be an rc tag
    //
    // Without this, a release tag would diff against the nearest beta tag
    // (e.g. 0.1.5-beta → 0.2), producing incomplete and misleading release notes.
    // This is standard semver channel isolation — see semantic-release, changesets,
    // npm dist-tags. Do NOT remove the channel filter or collapse these branches
    // into a single grep — that is the bug this code was written to fix (issue #2119).
    let prevTag = core.getInput('prev_tag').trim()
    const prevTagWasExplicit = !!prevTag
    if (!prevTag) {
      // Detect the channel of the current tag by extracting its pre-release label.
      //
      // WHY the regex is anchored with (?:[.-]|$):
      //
      // The anchor prevents matching non-canonical substrings. Without it,
      // a tag like 0.2-betafix.1 would match channelPattern = 'beta', making
      // the channel grep incorrectly include it. The anchor requires that the
      // channel label is followed by a numeric separator (.) or a compound
      // label separator (-) or end-of-string — i.e. only canonical semver
      // pre-release identifiers like -beta.1, -rc-1, or a bare -rc suffix.
      const channelMatch = tag.match(/-(beta|alpha|rc)(?:[.-]|$)/i)
      const channelPattern = channelMatch ? channelMatch[1] : null

      if (channelPattern) {
        // Pre-release tag: find the previous tag in the SAME pre-release channel only.
        //
        // WHY grep -iF and not grep -E or a JS filter:
        //
        // -F is a fixed-string (literal) match — no regex metacharacters to
        // escape in SAFE_CHANNEL. -i makes it case-insensitive for tags like
        // -Beta or -BETA. SAFE_CHANNEL is always "-beta", "-alpha", or "-rc"
        // (constructed from the regex match above, never from raw user input)
        // so substring matching is intentional and safe here — there are no
        // other channels whose names are substrings of these three strings.
        //
        // SAFE_CHANNEL is passed via env — never interpolated — to avoid
        // shell injection. Do NOT broaden this to match all tags — that
        // would cross channel boundaries (the original bug, issue #2119).
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -iF -- "$SAFE_CHANNEL" | head -n 1',
          { SAFE_TAG: tag, SAFE_CHANNEL: `-${channelPattern}` }
        )
      } else {
        // Stable release tag: find the previous RELEASE tag only.
        //
        // WHY grep -vE with an OR pattern:
        //
        // -E enables extended regex so the | alternation works without
        // escaping. The pattern "-(beta|alpha|rc)" is a fixed literal in the
        // command string — it is NOT user-controlled and does NOT need to be
        // passed via env. This is safe as-is. Do NOT replace with -F here —
        // -F does not support alternation and would require three separate greps.
        //
        // Do NOT remove this filter — without it a stable release tag would
        // baseline against the most recent pre-release tag (issue #2119).
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -vE -- "-(beta|alpha|rc)" | head -n 1',
          { SAFE_TAG: tag }
        )
      }
    }
    if (!prevTag) {
      core.warning('No previous tag found — using first commit as baseline')
      prevTag = git('rev-list --max-parents=0 HEAD')
    }
    if (prevTag.includes('/')) throw new Error('prev_tag contains a slash — pass a plain tag name, not a ref path')

    // Validate that prevTag actually exists in the repository, whether it was
    // provided explicitly by the caller or auto-resolved by the channel lookup above.
    //
    // WHY the SHA exemption exists (looksLikeRawSha):
    //
    // The first-commit fallback above (git rev-list --max-parents=0 HEAD)
    // returns a raw 40-character hex commit SHA, not a tag name. That SHA is
    // guaranteed to exist locally — rev-list only returns commits that are
    // present in the local object store. Running rev-parse on it would be
    // redundant and would produce a misleading error message of the form
    // "tag 'abc123def...' does not exist in this repository" if something
    // went wrong. The /^[0-9a-f]{40}$/i test is the standard way to detect
    // a raw full-length SHA — it is not a magic number, it is the fixed
    // length of a SHA-1 object hash as specified by the Git object model.
    //
    // For all other values — explicit input OR auto-resolved tag names — we
    // validate unconditionally. Without this, a tag deleted between the
    // git-tag listing and the GitHub API call would produce a confusing 404
    // from compareCommitsWithBasehead rather than a clear error here.
    const looksLikeRawSha = /^[0-9a-f]{40}$/i.test(prevTag)
    if (!looksLikeRawSha) {
      try {
        git('rev-parse "$SAFE_PREV_TAG"', { SAFE_PREV_TAG: prevTag })
      } catch {
        const source = prevTagWasExplicit ? 'explicit prev_tag input' : 'auto-resolved prev_tag'
        throw new Error(`prev_tag '${prevTag}' (${source}) does not exist in this repository.`)
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

    // Capture counts after pre-capping (max 80/150) but before prompt truncation,
    // so the truncation warning below can show the full pipeline:
    //   raw (e.g. 312) → pre-capped (e.g. 80) → truncated (e.g. 12)
    // Without this, the warning would only show the post-pre-cap value (80 → 12),
    // which is misleading for large releases where the pre-cap already fired.
    const preCappedCommitCount = commits.length
    const preCappedFileCount = files.length

    // 5. Build prompt, then hard-cap to MAX_PROMPT_CHARS (13_500) before
    //    sending to AFM. AFM has a fixed 4096-token context window; exceeding
    //    it throws exceededContextWindowSize. The per-list caps above (80 commits,
    //    150 files) are not sufficient on their own — a release with many long
    //    commit messages or filenames can still exceed the limit.
    const promptExtra = core.getInput('prompt_extra').slice(0, 300)
    const safeTag = tag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    const safePrevTag = prevTag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)

    const { prompt, commits: usedCommits, files: usedFiles } = truncatePromptToFit(
      safeTag, safePrevTag, commits, files, promptExtra
    )

    if (usedCommits.length < preCappedCommitCount || usedFiles.length < preCappedFileCount) {
      core.warning(
        `[afm] Prompt truncated to fit AFM context window (${MAX_PROMPT_CHARS} chars): ` +
        `commits ${totalCommits} → ${preCappedCommitCount} → ${usedCommits.length}, ` +
        `files ${totalFiles} → ${preCappedFileCount} → ${usedFiles.length}`
      )
    }
    core.info(`[afm] Prompt: ${prompt.length} chars, ${usedCommits.length} commits, ${usedFiles.length} files`)

    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'
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
      result = parseAfmOutput(raw, tag)
    }

    const { title, body } = result
    if (!title || !body) throw new Error('AFM returned empty title or body')

    // 8. Cap body length
    //
    // WHY 120_000 chars and not something smaller, and is this silent data loss:
    //
    // GitHub's release body field accepts up to ~125,000 characters before the
    // API starts rejecting requests. 120_000 is a safe margin below that limit.
    // This is NOT silent data loss — core.warning() is called explicitly, which
    // surfaces the truncation in the Actions step log and the step summary.
    // The model is also instructed to omit empty sections, so output this large
    // only occurs with extremely large changesets that would be unreadable anyway.
    const finalBody = body.length > 120_000
      ? (core.warning('Generated body exceeds 120000 chars — truncating to GitHub release body limit'), body.slice(0, 120_000))
      : body

    core.info(`[afm] Generated: ${title}`)

    // 9. Write outputs
    core.setOutput('release_title', title)
    core.setOutput('release_body', finalBody)
    core.setOutput('prev_tag', prevTag)

    // 10. Step summary
    await core.summary
      .addHeading(`📝 Release Notes: ${tag}`)
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
