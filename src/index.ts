import * as core from '@actions/core'
import * as github from '@actions/github'
import { execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import { git } from './git'
import { ensureBinary, httpsGetJson, httpsDownload, sha256File } from './binary'
import { afmCli, isFatalAfmError } from './afm'
import { parseAfmOutput, buildPrompt } from './prompt'

// TOKEN_BUDGET: the maximum number of tokens the prompt may consume.
//
// The on-device FoundationModels context window is 8,192 tokens (doubled from
// 4,096 in the rebuilt model — see afm-cli#2 / WWDC26). We reserve:
//   300 tokens — model response headroom
//    60 tokens — instructions string passed to LanguageModelSession(instructions:)
// Leaving 7,832 tokens available for the prompt.
//
// WHY the instructions reservation is an estimate, not an exact count:
// afm-cli --count-tokens measures the prompt argument only — instructions are
// passed separately to LanguageModelSession(instructions:) at inference time and
// are not included in the tokenCount(for:) result. The 60-token reserve is
// therefore a char-based estimate (~190 chars ÷ 3.29 chars/token ≈ 58 tokens).
// This is the only remaining estimation in an otherwise exact-count system.
// INVARIANT: keep the instructions string (defined below, step 5) under ~190 chars
// AND ASCII-only. Both constraints are enforced by runtime guards below.
// If the string must grow, recalculate and update the reserve here accordingly.
const TOKEN_BUDGET = 8192 - 300 - 60 // = 7832

// PROMPT_BUDGET: the ceiling used by the step-5 preflight halving loop.
//
// Reserves 50 tokens below TOKEN_BUDGET for the strictSuffix appended in step 7
// when the first parse fails. strictSuffix is ~130 chars / ~40 tokens; 50 tokens
// is a conservative upper bound. By reserving here rather than re-running the
// halving loop in step 7, the "strict-prompt overflow is impossible" invariant
// is established upfront — the step-7 TOKEN_BUDGET check becomes a true last-resort
// guard for pathological cases (e.g. a future suffix change that exceeds 50 tokens)
// rather than a normal near-ceiling failure mode.
//
// TOKEN_BUDGET (not PROMPT_BUDGET) is still used for the floor check in step 5:
// the floor prompt (boilerplate + no commits/files) is tiny and the full budget
// is appropriate there. Do NOT replace TOKEN_BUDGET with PROMPT_BUDGET in the
// floor check or the strict-retry overflow guard.
const PROMPT_BUDGET = TOKEN_BUDGET - 50 // = 7782

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

    // Verify --count-tokens is available. This flag requires macOS 26.4+
    // (SystemLanguageModel.tokenCount(for:) API). If the runner is on an older
    // macOS 26.x release, afm-cli exits 1 and we surface a clear error here
    // rather than letting the preflight loop throw mid-run with a cryptic message.
    //
    // WHY a dummy prompt instead of a dedicated --version or --ping flag:
    // afm-cli has no version/ping flag. Passing a minimal prompt exercises the
    // exact code path the preflight loop uses — if it exits 0 and returns a
    // number, the flag is available and the runner OS is sufficient.
    // The dummy prompt is intentionally short to keep the startup check fast.
    //
    // THREE distinct failure modes are handled separately in the catch below:
    //   A. isFatalAfmError returns true for a permission/MDM denial
    //      → binary is present but not authorised to run — surfaced as an
    //        access/MDM error, NOT a macOS version error.
    //   B. isFatalAfmError returns true for an availability/OS-version error
    //      → afm-cli ran but Apple Intelligence is unavailable or the OS is too
    //        old — surfaced as the macOS 26.4+ message.
    //   C. afmCli throws for any other reason (ENOMEM, spawn failure, etc.)
    //      → generic spawn error message.
    // Do NOT collapse A and B into a single isFatalAfmError branch — the
    // diagnoses are actionably different (check permissions vs. upgrade macOS).
    //
    // WHY /^\d+$/ instead of parseInt/isNaN:
    // parseInt("1 token", 10) === 1 — it stops at the first non-numeric character
    // and the isNaN guard passes silently. /^\d+$/ requires the entire string to be
    // digits, catching warning lines prepended to the count (e.g. "warning: ...\n1"
    // after trim) or suffixed units. Used consistently in probe and preflight loop.
    let probeRaw: string
    try {
      probeRaw = afmCli(afmBin, 'ping', { countTokens: true })
    } catch (e) {
      if (isFatalAfmError(e)) {
        const msg = String(e).toLowerCase()
        const isAccessDenied =
          /not authorized/i.test(msg) ||
          /permission denied/i.test(msg) ||
          /mdm policy/i.test(msg)
        if (isAccessDenied) {
          throw new Error(
            `[afm] afm-cli --count-tokens failed — binary not authorised to run. ` +
            'This is typically an MDM policy restriction or a missing entitlement. ' +
            `Runner OS: ${process.env.ImageOS ?? process.env.RUNNER_OS ?? 'unknown'}. ` +
            `Error: ${String(e)}`
          )
        }
        throw new Error(
          '[afm] afm-cli --count-tokens failed — this action requires macOS 26.4+. ' +
          `Runner OS: ${process.env.ImageOS ?? process.env.RUNNER_OS ?? 'unknown'}. ` +
          `Error: ${String(e)}`
        )
      }
      throw new Error(
        `[afm] afm-cli failed to spawn during --count-tokens probe (binary: ${afmBin}): ${String(e)}. ` +
        'Check that the binary is present, executable, and the runner has sufficient resources.'
      )
    }
    if (!/^\d+$/.test(probeRaw)) {
      throw new Error(
        `[afm] afm-cli --count-tokens returned unexpected output: "${probeRaw}". ` +
        'Expected a bare integer. This may indicate an afm-cli version mismatch or a warning line prepended to output.'
      )
    }
    // The probe integer is not used for budget calculations — this is an
    // availability check only. probeRaw is already validated as all-digits above.
    core.debug(`[afm] Startup probe token count: ${probeRaw}`)
    core.info('[afm] --count-tokens available ✓')

    // Instructions string for LanguageModelSession(instructions:).
    // Declared and validated here — before step 5 — so a violation is caught at
    // action startup rather than after all preflight CLI calls complete.
    //
    // TWO invariants are enforced by the runtime guards immediately below:
    //
    //   1. LENGTH ≤ 190 chars.
    //      The 60-token reserve in TOKEN_BUDGET is calibrated to this length
    //      (~190 chars ÷ 3.29 chars/token ≈ 58 tokens). Instructions are not
    //      included in the afm-cli --count-tokens result (passed separately at
    //      inference time), so this reservation is the only guard. If the string
    //      must grow, update the reserve in TOKEN_BUDGET.
    //
    //   2. ASCII-only.
    //      String.prototype.length counts UTF-16 code units, which equals char
    //      count only for ASCII. Non-ASCII characters (em-dash, curly quotes,
    //      CJK, etc.) tokenise at higher density than ASCII — adding them would
    //      silently underestimate the token cost and erode the 60-token reserve.
    //      The ASCII guard is machine-enforced (not comment-only) so a future
    //      edit introducing a non-ASCII character is caught at action startup
    //      rather than silently eroding the budget in production.
    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'
    if (/[^\x00-\x7F]/.test(instructions)) {
      throw new Error(
        '[afm] instructions string contains non-ASCII characters — violates the ASCII-only invariant. ' +
        'Non-ASCII characters tokenise at higher density and silently erode the 60-token TOKEN_BUDGET reserve. ' +
        'Use ASCII equivalents (e.g. hyphen instead of em-dash, straight quotes instead of curly quotes).'
      )
    }
    if (instructions.length > 190) {
      throw new Error(
        `[afm] instructions string is ${instructions.length} chars — exceeds the 190-char invariant. ` +
        'Update the TOKEN_BUDGET reserve if the string must grow.'
      )
    }
    const afmOptions = { instructions }

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

    // WHY control characters are stripped from commit messages and file paths:
    // safeTag, safePrevTag, and promptExtra all have /[\x00-\x1f\x7f]/g stripped
    // before being embedded in the prompt. Commit messages and file paths come
    // from the GitHub API and can contain control characters — in particular \n
    // and \r from multi-line commit messages, and \t from tooling-generated
    // messages. These are not a shell injection risk (afmCli uses spawnSync)
    // but they corrupt the "- ${msg}" / "- ${file}" line format in buildPrompt,
    // causing the model to see malformed bullet structure. Replaced with a space
    // rather than the empty string — invisible deletion is harder to diagnose
    // than a visible placeholder when debugging unexpected model output.
    let commits = compare.data.commits.map(c =>
      c.commit.message.replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd().slice(0, 120)
    )
    let files = compare.data.files?.map(f =>
      `${f.status} ${f.filename.replace(/[\x00-\x1f\x7f]/g, ' ')}`
    ) ?? []

    const totalCommits = commits.length
    const totalFiles = files.length

    if (totalCommits > 80) core.warning(`${totalCommits} commits — prompt capped at 80`)
    if (totalFiles > 150) core.warning(`${totalFiles} files — prompt capped at 150`)

    commits = commits
      .filter(m => !/^(fixup!|squash!|[Ww][Ii][Pp]([ :]|$))/.test(m))
      .slice(0, 80)
    files = files.slice(0, 150)

    const postFilterCommitCount = commits.length
    const postFilterFileCount = files.length

    // 5. Assemble prompt and preflight token count
    //
    // WHY promptExtra is also stripped of control chars:
    // safeTag and safePrevTag both apply /[\x00-\x1f\x7f]/g before being
    // embedded in the prompt. promptExtra comes from core.getInput(), which
    // passes caller-supplied workflow input through unchanged. Not a shell
    // injection risk (afmCli uses spawnSync), but control chars could corrupt
    // the prompt content or cause unexpected model behaviour. Strip applied
    // consistently with all other user-controlled strings embedded in the prompt.
    //
    // WHY warn on prompt_extra truncation:
    // The 300-char cap on prompt_extra is a silent slice — a user who supplies
    // a longer instruction string would have it truncated with no log entry,
    // potentially causing confusing model output. The warning is emitted before
    // slicing so the original length is visible in the Actions log.
    const promptExtraRaw = core.getInput('prompt_extra').replace(/[\x00-\x1f\x7f]/g, '')
    if (promptExtraRaw.length > 300) {
      core.warning(
        `[afm] prompt_extra is ${promptExtraRaw.length} chars — truncating to 300. ` +
        'Shorten the prompt_extra input to suppress this warning.'
      )
    }
    const promptExtra = promptExtraRaw.slice(0, 300)
    const safeTag = tag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    const safePrevTag = prevTag.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)

    // Preflight loop: call afm-cli --count-tokens to get the exact token count
    // for the assembled prompt. Halve both lists until the count fits PROMPT_BUDGET.
    //
    // WHY PROMPT_BUDGET (not TOKEN_BUDGET) here:
    // PROMPT_BUDGET = TOKEN_BUDGET - 50. The 50-token reserve is headroom for
    // strictSuffix (~40 tokens) appended in step 7 on parse failure. Reserving
    // upfront means step 7 can always append strictSuffix without a context
    // overflow — the step-7 TOKEN_BUDGET guard is a last-resort invariant check
    // for pathological cases (e.g. a future strictSuffix > 50 tokens), not a
    // normal failure mode. See PROMPT_BUDGET declaration above for full rationale.
    //
    // WHY exact token counts instead of a char-budget estimate:
    // The char-budget approach (MAX_PROMPT_CHARS = 12_000) used ~3.29 chars/token
    // as a worst-case estimate. Token density varies by content type — CJK text,
    // dense commit messages, and generated output all tokenise differently.
    // afm-cli --count-tokens calls SystemLanguageModel.tokenCount(for:), which
    // returns the exact count the model sees, making overflow impossible.
    //
    // WHY > 1 and not > 0 in the halving condition:
    // With > 0: if promptCommits=1 and promptFiles=[] (or vice versa), the outer
    // condition stays true but neither inner guard fires, spinning forever.
    // > 1 exits the loop as soon as neither list can shrink further and the
    // floor break below handles the residual case.
    //
    // DOES THIS LOOP TERMINATE?
    // Yes. Math.floor(n/2) with Math.max(1, ...) pegs each list at 1 once n=1.
    // Once both lists are at 1, the (> 1 || > 1) condition is false and the
    // loop exits. The floor break fires first if the boilerplate alone exceeds
    // PROMPT_BUDGET (extremely unusual — would require a tag name of ~28,000 tokens).
    //
    // LOOP INVARIANT: prompt is always built at the bottom of each iteration (or
    // at init below), then measured at the top of the next iteration. The version
    // of prompt that exits via `break` is the one just measured and confirmed to
    // fit — it is the prompt passed to inference in step 6.
    let promptCommits = [...commits]
    let promptFiles = [...files]
    let prompt = buildPrompt(safeTag, safePrevTag, promptCommits, promptFiles, promptExtra)

    core.info('[afm] Running token preflight...')
    while (true) {
      const raw = afmCli(afmBin, prompt, { countTokens: true })
      // Guard: afm-cli --count-tokens must return a bare integer. /^\d+$/ is used
      // instead of parseInt/isNaN because parseInt("1 token", 10) === 1 — it stops
      // at the first non-numeric character and the isNaN guard passes silently.
      // /^\d+$/ requires the full string to be digits, catching prepended warning
      // lines or suffixed units that parseInt would silently accept.
      if (!/^\d+$/.test(raw)) {
        throw new Error(`[afm] --count-tokens returned non-numeric output: "${raw}"`)
      }
      const tokenCount = parseInt(raw, 10)
      core.debug(`[afm] Preflight token count: ${tokenCount} / ${PROMPT_BUDGET}`)
      if (tokenCount <= PROMPT_BUDGET) break // prompt holds the version just measured and confirmed to fit
      if (promptCommits.length <= 1 && promptFiles.length <= 1) {
        // Floor: boilerplate + 1 commit + 1 file still exceeds budget.
        // Extremely unusual — drop both lists and proceed. The model will
        // generate a minimal release note from tag names alone.
        core.warning(
          '[afm] Preflight: prompt exceeds PROMPT_BUDGET even at minimum list size — ' +
          'dropping all commits and files. Release note will have no diff context.'
        )
        promptCommits = []
        promptFiles = []
        prompt = buildPrompt(safeTag, safePrevTag, promptCommits, promptFiles, promptExtra)
        // Measure the floor prompt before proceeding to preserve the invariant
        // that step 6 always receives a prompt confirmed to fit TOKEN_BUDGET.
        // TOKEN_BUDGET (not PROMPT_BUDGET) is correct here: the floor prompt has
        // no list content, so strict-suffix headroom is not required.
        // Boilerplate-only prompts are tiny in practice, but the guarantee should
        // be exact rather than assumed.
        const floorRaw = afmCli(afmBin, prompt, { countTokens: true })
        if (!/^\d+$/.test(floorRaw)) throw new Error(`[afm] --count-tokens returned non-numeric output on floor prompt: "${floorRaw}"`)
        const floorCount = parseInt(floorRaw, 10)
        if (floorCount > TOKEN_BUDGET) throw new Error(`[afm] Floor prompt (boilerplate only) exceeds TOKEN_BUDGET (${floorCount} > ${TOKEN_BUDGET}). Tag names may be pathologically long.`)
        core.debug(`[afm] Floor prompt token count: ${floorCount} / ${TOKEN_BUDGET}`)
        break
      }
      if (promptCommits.length > 1) promptCommits = promptCommits.slice(0, Math.max(1, Math.floor(promptCommits.length / 2)))
      if (promptFiles.length > 1) promptFiles = promptFiles.slice(0, Math.max(1, Math.floor(promptFiles.length / 2)))
      prompt = buildPrompt(safeTag, safePrevTag, promptCommits, promptFiles, promptExtra)
    }

    if (promptCommits.length < postFilterCommitCount || promptFiles.length < postFilterFileCount) {
      core.warning(
        `[afm] Prompt truncated to fit PROMPT_BUDGET (${PROMPT_BUDGET} tokens): ` +
        `commits ${totalCommits} → ${postFilterCommitCount} → ${promptCommits.length}, ` +
        `files ${totalFiles} → ${postFilterFileCount} → ${promptFiles.length}`
      )
    }
    core.info(`[afm] Prompt ready: ${prompt.length} chars, ${promptCommits.length} commits, ${promptFiles.length} files`)

    // 6. Call afm-cli
    //
    // Context overflow is impossible here — the preflight loop (step 5) has
    // confirmed the prompt fits within PROMPT_BUDGET (TOKEN_BUDGET - 50), which
    // includes headroom for the strictSuffix appended in step 7.
    // The only transient failure mode is ETIMEDOUT (cold-start model load).
    // isFatalAfmError() is called first to avoid retrying unrecoverable errors.
    core.info('[afm] Calling afm-cli...')
    let raw = ''
    try {
      raw = afmCli(afmBin, prompt, afmOptions)
    } catch (e) {
      core.debug(`[afm] Attempt 1 error: ${String(e)}`)
      if (isFatalAfmError(e)) throw e

      // Cold-start / transient error — wait 15s and retry.
      core.info('[afm] Attempt 1 failed — retrying in 15s (cold-start model load)...')
      await new Promise(r => setTimeout(r, 15_000))
      try {
        raw = afmCli(afmBin, prompt, afmOptions)
      } catch (e2) {
        if (isFatalAfmError(e2)) throw e2
        const detail = String(e2)
        throw new Error(
          `[afm] Cold-start retry failed (binary: ${afmBin}): ${detail}. ` +
          'If this is ETIMEDOUT, the model may need more than 60s to load on first run — ' +
          'consider increasing the timeout or pre-warming the runner.'
        )
      }
    }

    if (!raw) throw new Error('afm-cli returned empty output')

    // 7. Parse output — strict-prompt retry if the format is wrong.
    //
    // strictSuffix is appended to prompt when the first parse fails. The combined
    // strictPrompt fits within TOKEN_BUDGET because the step-5 preflight loop
    // halved the base prompt to PROMPT_BUDGET = TOKEN_BUDGET - 50, reserving
    // exactly the headroom strictSuffix needs (~40 tokens). The TOKEN_BUDGET
    // guard below is therefore a true invariant check — it can only fire if
    // strictSuffix is ever changed to exceed 50 tokens.
    //
    // WHY a single cold-start retry in step 7:
    // Step 7 runs after step 6 returned output — the model is warm in the common
    // case. However, if step 6 succeeded on attempt 1 and the model subsequently
    // unloads under memory pressure before step 7 runs, the strict-retry inference
    // call can ETIMEDOUT with the model cold again. A single 15s wait-and-retry
    // (identical to step 6's pattern) recovers this edge without adding a full
    // retry loop. Fatal errors still skip the retry immediately.
    const strictSuffix = '\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}'
    let result: { title: string; body: string }
    try {
      result = parseAfmOutput(raw, tag)
    } catch (e) {
      core.warning(`Output malformed — retrying with stricter prompt: ${e}`)
      const strictPrompt = prompt + strictSuffix
      core.info(`[afm] Strict-retry prompt: ${strictPrompt.length} chars`)
      const strictRaw = afmCli(afmBin, strictPrompt, { countTokens: true })
      if (!/^\d+$/.test(strictRaw)) throw new Error(`[afm] --count-tokens returned non-numeric output for strict prompt: "${strictRaw}"`)
      const strictTokenCount = parseInt(strictRaw, 10)
      core.debug(`[afm] Strict-retry token count: ${strictTokenCount} / ${TOKEN_BUDGET}`)
      if (strictTokenCount > TOKEN_BUDGET) throw new Error(
        `[afm] Strict-retry prompt exceeds TOKEN_BUDGET (${strictTokenCount} > ${TOKEN_BUDGET}) — ` +
        `strictSuffix has grown beyond the 50-token reserve in PROMPT_BUDGET. ` +
        `Update the PROMPT_BUDGET reserve (currently TOKEN_BUDGET - 50) to match the new strictSuffix token cost. ` +
        `(commits in prompt: ${promptCommits.length}, files in prompt: ${promptFiles.length})`
      )
      try {
        raw = afmCli(afmBin, strictPrompt, afmOptions)
      } catch (e2) {
        core.debug(`[afm] Strict-retry attempt 1 error: ${String(e2)}`)
        if (isFatalAfmError(e2)) throw e2
        // Model may have unloaded between step 6 success and this call — wait and retry once.
        core.info('[afm] Strict-retry attempt 1 failed — retrying in 15s...')
        await new Promise(r => setTimeout(r, 15_000))
        try {
          raw = afmCli(afmBin, strictPrompt, afmOptions)
        } catch (e3) {
          if (isFatalAfmError(e3)) throw e3
          throw new Error(
            `[afm] Strict-prompt retry failed after cold-start recovery (binary: ${afmBin}): ${String(e3)}. ` +
            'If this is ETIMEDOUT, the model may need more than 60s to load — ' +
            'consider increasing the timeout or pre-warming the runner.'
          )
        }
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
