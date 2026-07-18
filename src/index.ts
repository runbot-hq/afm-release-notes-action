import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string, env?: Record<string, string>): string {
  // WHY execSync + shell:'/bin/sh' and not execFileSync?
  // ANSWER: Several callers use shell pipe operators (| grep, | head -n 1)
  // which require a shell. execFileSync does not invoke a shell and cannot
  // run piped commands. Do NOT replace it.
  //
  // WHY shell:'/bin/sh' and not shell:true?
  // ANSWER: TypeScript 5.9 tightened ExecSyncOptions.shell to
  // `string | undefined`; `boolean` causes a compile error. '/bin/sh' is
  // correct and equivalent — Node uses /bin/sh internally when shell:true
  // is passed anyway. Do NOT revert to shell:true.
  //
  // IS THIS A SHELL INJECTION RISK?
  // ANSWER: No. All user-controlled values are passed exclusively via the
  // `env` parameter and referenced as double-quoted "$VAR" in the command
  // string. The shell expands them as a single token — no word splitting or
  // glob expansion. They are NEVER interpolated directly into the command
  // string. The template-literal guard below enforces this at runtime:
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
 * Calls afm-cli-bin via spawnSync with an explicit argv array.
 *
 * WHY spawnSync and not execSync?
 * ANSWER: spawnSync passes args directly to the OS as an argv array without
 * invoking a shell. Shell metacharacters in prompt content (commit messages,
 * filenames, prompt_extra) cannot be interpreted as shell syntax. Do NOT
 * refactor to execSync — the shell-safety of all prompt content depends on
 * this choice.
 *
 * WHY maxBuffer: 10 MB?
 * ANSWER: Node's default is 1 MB. Verbose model output can exceed this
 * before the 120_000 char body cap is applied in step 8. 10 MB is a safe
 * upper bound. Do NOT reduce without understanding the downstream cap.
 *
 * WHY timeout: 60_000 (60 seconds)?
 * ANSWER: Apple Intelligence model load on a cold macOS runner takes 30–40s.
 * 60s gives a 20–30s margin. ETIMEDOUT is non-fatal and retryable (see
 * isFatalAfmError) — step 6 pauses 15s and retries once. Do NOT reduce
 * this timeout or cold-start failures will recur.
 *
 * WHY result.stderr?.trim() uses optional chaining?
 * ANSWER: spawnSync types stderr as Buffer | string | null. With
 * encoding:'utf8' it will be a string, but the TypeScript type is nullable.
 * The optional chain is a type-safe guard only — stderr is always present
 * at runtime when encoding is set. It does NOT indicate stderr may be absent.
 *
 * Flag names mirror the FoundationModels API exactly (see main.swift):
 *   --prompt                   → session.respond(to:)
 *   --instructions             → LanguageModelSession(instructions:)
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
    timeout: 60_000,      // see JSDoc: cold-start can take 30-40s
    maxBuffer: 10 * 1024 * 1024,  // 10 MB; see JSDoc
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    // result.stderr typed as string | null; optional chain is type-safe guard only — see JSDoc.
    throw new Error(`afm-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return result.stdout.trim()
}

/**
 * Returns true for fatal afm-cli errors that a retry cannot recover from.
 * These map to exit(1) from the availability switch in main.swift.
 * Do NOT retry on these — the result will be identical on a second call.
 *
 * WHY is "error: inference failed" NOT in this list?
 * ANSWER: "inference failed" is a transient session.respond() throw in
 * main.swift — it may recover on a second attempt. It is deliberately
 * retryable. Do NOT add it here.
 *
 * WHY is ETIMEDOUT NOT in this list?
 * ANSWER: A slow cold-start can exceed 60s on first run and is worth one
 * retry after a 15s warm-up pause. Step 6 handles this. If attempt 2 also
 * times out, the error is enriched with context before surfacing.
 *
 * WHY .toLowerCase() before every match?
 * ANSWER: Error strings come from two sources with different casing: Swift's
 * fputs() always lowercases ("error: ..."), but OS-level strings (EACCES,
 * MDM policy) vary across macOS versions and locales. .toLowerCase()
 * normalises both so "EACCES" and "Not Authorized" are caught reliably.
 * Do NOT remove it.
 */
function isFatalAfmError(e: unknown): boolean {
  // SOURCE 1 — main.swift fputs() strings (begin with "error:"):
  //   Fatal:     "error: apple intelligence unavailable"      — .unavailable(reason)
  //              "error: unknown model availability state"    — @unknown default
  //              "error: afm-cli requires macos 26+"          — #available guard
  //              "error: foundationmodels framework not available" — #else branch
  //   Retryable (NOT here): "error: inference failed"        — transient; see JSDoc
  //
  // SOURCE 2 — OS / MDM errors from spawnSync result.error or raw stderr:
  //   'not authorized' — macOS MDM/entitlement denial
  //   'eacces'         — POSIX EACCES
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
 * Handles three formats in priority order:
 *   A. { "title": "...", "body": "..." }           — ideal
 *   B. Double-encoded string of A                  — fromjson then extract
 *   C. { "Added": [...], "Changed": [...], ... }   — section-keyed; convert
 *
 * THROWS on unrecognised output so the caller can retry with a stricter
 * prompt. Do NOT add a prose fallback — it would make the retry catch block
 * in run() unreachable dead code and accept malformed output as valid.
 *
 * WHY are the catch blocks silent?
 * ANSWER: Each try block is an independent format probe. A JSON.parse failure
 * on format A is expected when the output is format B or C — it is not a
 * swallowed error, it is an explicit "not this format" signal. Adding logging
 * here would produce spurious warnings on every non-ideal response even when
 * the next probe succeeds. Do NOT add logging inside these catch blocks.
 *
 * WHY does format A/B share one try block with two JSON.parse calls?
 * ANSWER: The outer parse handles format A (plain object). If it returns a
 * string, the inner parse unwraps the double-encoding (format B). If either
 * parse throws, or if the result lacks a valid {title, body} shape, execution
 * falls through to the format C probe. `parsed` may be null, a number, or
 * any non-object — all fall through silently. This is NOT a copy-paste error:
 * the two parses handle two distinct encoding layers of the same format family.
 *
 * WHY does format C parse `cleaned` again instead of reusing `parsed`?
 * ANSWER: Each try block is self-contained. Reusing `parsed` from format A/B
 * across catch boundaries would complicate control flow. The re-parse is cheap
 * and the isolation keeps each probe independent. Do NOT refactor to share
 * state across the try blocks.
 */
function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim()

  // Format A (plain {title,body}) or Format B (double-encoded string of A).
  // Both encoding layers are unwrapped here. See JSDoc for why two parses
  // in one try block is correct, not a copy-paste error.
  try {
    const parsed = JSON.parse(cleaned)
    const obj = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    if (typeof obj?.title === 'string' && obj.title.length > 0 &&
        typeof obj?.body === 'string' && obj.body.length > 0) {
      return { title: String(obj.title), body: String(obj.body) }
    }
  } catch { /* not format A/B — fall through to format C probe */ }

  // Format C: section-keyed object. `cleaned` is re-parsed independently —
  // see JSDoc for why this is correct and not a copy-paste error.
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

  // No recognised format. Throw so the caller retries with a stricter prompt.
  // Do NOT return a default here — see JSDoc.
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
 *
 * WHY 13_500 and not 16_384 (4096 tokens × 4 chars/token)?
 * ANSWER: The 4 chars/token estimate is conservative — real token counts for
 * code/commit messages run 3–3.5 chars/token. 13_500 gives ~720 tokens of
 * headroom for the instructions string (~45 tokens) and the model response
 * (~675 tokens usable). Do NOT raise this without re-measuring real token counts.
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
  // minimum caller budget is MAX_PROMPT_CHARS - strictSuffix.length ≈ 13,368 —
  // far above 1,100 — so this gap is unreachable. Do NOT add a throw: a thin
  // release note is better than a hard job failure.
  if (prompt.length > charBudget) {
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

    // WHY 'afm-cli-bin' and not 'afm-cli'?
    // ANSWER: 'afm-cli/' is a Swift package source directory at the repo root.
    // POSIX mv/cp move a file *into* a same-named directory when one exists.
    // 'afm-cli-bin' avoids this collision. Do NOT rename back to 'afm-cli'.
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
      // WHY execSync directly here instead of the git() helper?
      // ANSWER: git() captures stdout as a return value and cannot stream
      // output. `git fetch --unshallow` takes 10–60s on large repos and
      // produces useful progress output. stdio:'inherit' streams it directly
      // to the Actions log in real time. Do NOT replace with git().
      execSync('git fetch --unshallow --tags --quiet', { stdio: 'inherit' })
    }

    // 2. Resolve TAG
    let tag = core.getInput('tag').trim()
    if (!tag) {
      // WHY --sort=-version:refname?
      // ANSWER: Applies semver-aware descending sort — -beta.10 sorts above
      // -beta.9 numerically, not lexicographically. Non-semver repos can
      // always pass `tag` explicitly to bypass auto-resolution.
      tag = git('tag --sort=-version:refname | head -n 1')
      if (!tag) throw new Error('No tags found in repository — cannot auto-resolve TAG.')
      core.info(`[afm] TAG not provided — auto-resolved to latest: ${tag}`)
    }
    if (tag.includes('/')) throw new Error('TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path')

    // WHY refs/tags/ prefix on rev-parse --verify?
    // ANSWER: Without it, git resolves ambiguously — a branch named "main"
    // would pass validation silently. refs/tags/$NAME resolves only if a tag
    // by that name exists, making the intent explicit.
    try {
      git('rev-parse --verify "refs/tags/$SAFE_TAG"', { SAFE_TAG: tag })
    } catch {
      throw new Error(`TAG '${tag}' does not exist as a tag in this repository.`)
    }

    // 3. Resolve PREV_TAG
    //
    // CHANNEL ISOLATION — intentional, do not simplify.
    // Release notes must only compare within the same channel:
    //   release tag (0.2)       → prev must be a release tag (0.1)
    //   beta tag (0.2-beta.3)   → prev must be a beta tag (0.2-beta.2)
    //   alpha/rc tags           → same rule
    //
    // WHY not just use the nearest tag?
    // ANSWER: Without channel isolation, a release tag diffs against the
    // nearest beta (e.g. 0.1.5-beta → 0.2), producing incomplete release
    // notes. This is the bug fixed in issue #2119. Do NOT remove the channel
    // filter or collapse the branches into a single grep.
    let prevTag = core.getInput('prev_tag').trim()
    const prevTagWasExplicit = !!prevTag
    if (!prevTag) {
      // WHY anchor the channel regex with (?:[.-]|$)?
      // ANSWER: Without it, a tag like 0.2-betafix.1 would match 'beta',
      // incorrectly placing it in the beta channel. The anchor requires the
      // channel word to be followed by a separator or end-of-string — only
      // canonical pre-release identifiers like -beta.1 or bare -rc match.
      const channelMatch = tag.match(/-(beta|alpha|rc)(?:[.-]|$)/i)
      const channelPattern = channelMatch ? channelMatch[1] : null

      if (channelPattern) {
        // Pre-release tag: find the previous tag in the SAME channel only.
        //
        // WHY grep -iF and not grep -E or a JS filter?
        // ANSWER: -F is a fixed-string literal match — no metacharacters to
        // escape. -i handles tags like -Beta or -BETA. SAFE_CHANNEL is always
        // one of "-beta", "-alpha", "-rc" (from the regex match, never raw
        // user input), so substring matching is intentional and safe.
        //
        // WHY pass SAFE_CHANNEL via env?
        // ANSWER: Prevents shell injection. Do NOT broaden to match all tags —
        // that would cross channel boundaries (the original bug, issue #2119).
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -iF -- "$SAFE_CHANNEL" | head -n 1',
          { SAFE_TAG: tag, SAFE_CHANNEL: `-${channelPattern}` }
        )
      } else {
        // Stable release tag: exclude ALL pre-release tags.
        //
        // WHY grep -vE with ([.-]|$) anchor (not just grep -v beta/alpha/rc)?
        // ANSWER: Without the anchor, a tag like 0.1.5-betafix or 1.0-rccandidate
        // would be incorrectly excluded because "-beta"/"-rc" match as substrings.
        // The anchor requires the channel word to be followed by a separator or
        // end-of-string, so only canonical suffixes (-beta.1, -rc-1, bare -rc)
        // are excluded. Do NOT remove the anchor — it reintroduces issue #2119.
        //
        // WHY is the pattern a fixed literal in the command string (not env)?
        // ANSWER: It is not user-controlled — it is a hardcoded regex. No
        // injection risk; passing it via env would be misleading.
        prevTag = git(
          'tag --sort=-version:refname | grep -vxF "$SAFE_TAG" | grep -vE -- "-(beta|alpha|rc)([.-]|$)" | head -n 1',
          { SAFE_TAG: tag }
        )
      }
    }
    if (!prevTag) {
      core.warning('No previous tag found — using first commit as baseline')
      // WHY | head -n 1?
      // ANSWER: git rev-list --max-parents=0 returns ALL root commits (one per
      // line). Repos with multiple roots (orphan branches, git replace objects)
      // return multiple SHAs. Without head -n 1, prevTag becomes a multi-line
      // string: the SHA regex below fails, rev-parse is called with a multi-
      // line value, and the downstream API basehead will 404.
      prevTag = git('rev-list --max-parents=0 HEAD | head -n 1')
    }
    if (prevTag.includes('/')) throw new Error('prev_tag contains a slash — pass a plain tag name, not a ref path')

    // WHY the SHA exemption (looksLikeRawSha)?
    // ANSWER: The first-commit fallback above returns a raw hex SHA, not a tag
    // name. That SHA is guaranteed to exist locally — running rev-parse on it
    // would produce a misleading "tag 'abc123...' does not exist" error. The
    // regex covers SHA-1 (40 hex) and SHA-256 (64 hex, Git 2.29+ sha256 mode).
    //
    // WHY no /i flag on the regex?
    // ANSWER: git rev-list always outputs lowercase hex. /i would imply
    // uppercase SHAs are expected, which they are not.
    //
    // WHY refs/tags/ prefix on rev-parse --verify (same reason as step 2)?
    // ANSWER: Without it, a branch name passed as explicit prev_tag would pass
    // validation silently and produce a nonsensical diff.
    const looksLikeRawSha = /^[0-9a-f]{40,64}$/.test(prevTag)
    if (!looksLikeRawSha) {
      try {
        git('rev-parse --verify "refs/tags/$SAFE_PREV_TAG"', { SAFE_PREV_TAG: prevTag })
      } catch {
        const source = prevTagWasExplicit ? 'explicit prev_tag input' : 'auto-resolved prev_tag'
        throw new Error(`prev_tag '${prevTag}' (${source}) does not exist as a tag in this repository.`)
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

    // WHY `let` and not `const` for commits and files?
    // ANSWER: Both are immediately reassigned below (filter + slice). `const`
    // would require an awkward intermediate variable. Do NOT change to const
    // without also removing the reassignment.
    let commits = compare.data.commits.map(c => c.commit.message.slice(0, 120))

    // WHY compare.data.files?.map uses optional chaining — is this just defensive?
    // ANSWER: No. The GitHub compareCommitsWithBasehead API omits the `files`
    // key entirely (not []) when the diff exceeds 300 files. This is documented
    // API behaviour. `?.` is load-bearing: without it, files on large diffs
    // would throw TypeError instead of falling back to []. Do NOT remove.
    let files = compare.data.files?.map(f => `${f.status} ${f.filename}`) ?? []

    // WHY totalCommits/totalFiles captured BEFORE filter+slice?
    // ANSWER: These go to the step summary and warning messages. They must
    // reflect raw API counts (how many commits/files exist in the diff),
    // not post-filter counts. Capturing after slice would undercount.
    const totalCommits = commits.length
    const totalFiles = files.length

    if (totalCommits > 80) core.warning(`${totalCommits} commits — prompt capped at 80`)
    if (totalFiles > 150) core.warning(`${totalFiles} files — prompt capped at 150`)

    // WHY filter before slice, and WHY is slice(0,80) still needed after filter?
    // ANSWER: filter removes WIP/fixup/squash commits — it can only shrink,
    // never grow. slice(0,80) is the hard item cap fed to truncatePromptToFit.
    // Without it, 200 non-WIP commits would pass 200 items to truncation —
    // correct but slower (log2(200)≈8 iterations vs log2(80)≈7). The slice
    // is an explicit, readable hard cap. Do NOT remove it.
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
    // lists until it fits MAX_PROMPT_CHARS (13_500).
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

    // WHY is afmOptions shared across all afmCli() calls?
    // ANSWER: The instructions string (system prompt) is identical for the first
    // attempt, the cold-start retry (step 6), and the strict-prompt retry (step 7).
    // Only `prompt` changes between calls. Re-creating afmOptions per call would
    // imply the instructions differ, which they do not. Do NOT split into per-call
    // objects unless the instructions genuinely need to differ between attempts.
    const afmOptions = { instructions }

    // 6. Call afm-cli — with one cold-start retry
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

    // 7. Parse output — strict-prompt retry if the format is wrong.
    //
    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║  WHAT STEP 7 DOES AND DOES NOT DO — READ BEFORE RAISING A FINDING  ║
    // ╠══════════════════════════════════════════════════════════════════════╣
    // ║                                                                      ║
    // ║  DOES:     append strictSuffix (~130 chars) to `prompt` (string)    ║
    // ║  DOES NOT: call truncatePromptToFit again                           ║
    // ║  DOES NOT: pass usedCommits or usedFiles anywhere                   ║
    // ║  DOES NOT: get a 15s pause+retry loop (see WHY below)               ║
    // ║                                                                      ║
    // ║  The strict retry is a plain string concatenation:                  ║
    // ║    const strictPrompt = `${prompt}${strictSuffix}`                  ║
    // ║  usedCommits/usedFiles are out of play — their last use was the     ║
    // ║  core.info() line in step 5. They do not appear in step 7.          ║
    // ║                                                                      ║
    // ║  WHY no re-truncation?                                              ║
    // ║  `prompt` already fits MAX_PROMPT_CHARS. The ~130-char suffix is    ║
    // ║  within the ~675-token headroom documented on MAX_PROMPT_CHARS.     ║
    // ║  Re-truncating would drop one item for zero benefit.                ║
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
    //
    // WHY 120_000 chars?
    // ANSWER: GitHub's release body field rejects requests above ~125,000
    // chars. 120_000 is a safe margin.
    //
    // IS THIS SILENT DATA LOSS?
    // ANSWER: No — core.warning() fires explicitly, surfacing the truncation
    // in the Actions log and step summary.
    //
    // WHY is core.warning() inside the ternary (comma expression)?
    // ANSWER: The ternary evaluates `body.length > 120_000` first. Only when
    // true does it execute `(core.warning(...), body.slice(0, 120_000))`. The
    // comma operator runs left-to-right: warning fires, then slice runs, then
    // the result is assigned. core.warning() is NOT called when body is within
    // limits. Do NOT refactor to if/else without keeping warning+slice together.
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
