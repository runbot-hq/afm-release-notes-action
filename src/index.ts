import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import { git } from './git'
import { ensureBinary, httpsGetJson, httpsDownload, sha256File } from './binary'
import { afmCli, isFatalAfmError, isContextOverflowError } from './afm'
import { PARSE_FAILED, parseAfmOutput, MAX_PROMPT_CHARS, buildPrompt, truncatePromptToFit } from './prompt'

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
    // IMPORTANT: strictSuffix must contain only single-code-unit characters (U+0000–U+007F).
    // String.prototype.length counts UTF-16 code units. For characters in this range
    // .length equals the character count AFM sees, keeping the charBudget math exact.
    // Any character outside this range (emoji, non-ASCII letters, arrows, curly quotes)
    // is encoded as two UTF-16 code units (surrogate pair) or as a multi-byte UTF-8
    // sequence, making .length smaller than the actual encoded size and silently
    // underestimating the remaining budget. The guard below catches this at action
    // startup — long before any AFM call — so the miscalculation is caught in CI
    // rather than corrupting a live release. (~130 chars)
    const strictSuffix = '\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}'
    // Guard: rejects any character above U+007F (i.e. outside the single-code-unit
    // ASCII range). Control characters (U+0000–U+001F, U+007F) are single-code-unit
    // and do not affect .length accuracy — they are intentionally allowed through.
    // The risk being guarded is multi-byte characters (U+0080+), not control chars.
    if (!/^[\x00-\x7f]*$/.test(strictSuffix)) {
      throw new Error('Internal error: strictSuffix contains characters above U+007F — charBudget calculation would be incorrect. Keep all characters in the U+0000–U+007F range.')
    }

    // usedCommits/usedFiles: post-truncation lists retained for use in three places:
    //   1. The truncation warning and core.info log immediately below.
    //   2. Step 6's overflow-retry path — passed to truncatePromptToFit with a
    //      reduced budget so the halving loop can shed additional items. If the
    //      overflow path runs, activeCommits/activeFiles are updated to the
    //      narrower overflow lists so step 7 works from the smallest known-good set.
    //   3. Step 7's strict-retry path — uses activeCommits/activeFiles (initialised
    //      to usedCommits/usedFiles here, updated by step 6 overflow path if taken)
    //      so the strict-retry never re-expands to a prompt larger than the one
    //      that last succeeded.
    const { prompt, commits: usedCommits, files: usedFiles } = truncatePromptToFit(
      safeTag, safePrevTag, commits, files, promptExtra
    )
    // activeCommits/activeFiles track the narrowest truncated lists seen so far.
    // Initialised from step 5; updated to overflowCommits/overflowFiles if step 6
    // takes the overflow-retry path. Step 7 always reads from these so it never
    // re-expands past the last known-good truncation boundary.
    let activeCommits = usedCommits
    let activeFiles = usedFiles
    // activeOverflowBudget tracks the tightest char budget seen so far.
    // Defaults to MAX_PROMPT_CHARS (no overflow path taken). Updated to
    // overflowBudget if step 6 takes the overflow-retry path, so step 7
    // caps its budget to Math.min(MAX_PROMPT_CHARS, activeOverflowBudget)
    // - strictSuffix.length and never sends a prompt larger than the one
    // that already overflowed.
    let activeOverflowBudget = MAX_PROMPT_CHARS
    // priorOverflowDetail captures the step-6 overflow error string if the
    // overflow path was taken. Appended to any subsequent failure message so
    // that a double-failure (overflow → malformed strict-retry output) carries
    // the full error chain in core.setFailed rather than only the later error.
    let priorOverflowDetail: string | undefined

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
        // deterministic. 75% (not 50%) is intentional: with MAX_PROMPT_CHARS at
        // 12,000 chars, a prompt that still overflows has a token density higher
        // than ~3.41 chars/token (the density at which 12,000 chars hits 4,096
        // tokens less response/instructions headroom). At 75% the budget becomes
        // ~9,000 chars ≈ 2,735 tokens — well within the limit even at extreme
        // densities, while preserving more commit context than a 50% cut would.
        // If the re-truncated prompt still overflows (extremely unusual), it will
        // throw and surface via core.setFailed with the overflow detail.
        core.warning(`[afm] Attempt 1 — context window overflow (${String(e).slice(0, 120)}). Re-truncating to 75% and retrying immediately...`)
        const overflowBudget = Math.floor(Math.min(prompt.length, MAX_PROMPT_CHARS) * 0.75)
        // usedCommits/usedFiles intentionally — already-capped by step 5; passing
        // the original lists would re-expand the prompt past overflowBudget.
        const { prompt: smallerPrompt, commits: overflowCommits, files: overflowFiles } = truncatePromptToFit(
          safeTag, safePrevTag, usedCommits, usedFiles, promptExtra, overflowBudget
        )
        // Update activeCommits/activeFiles/activeOverflowBudget to the narrower
        // overflow values so that step 7's strict-retry (if needed) builds from
        // the smallest known-good truncation boundary and budget, never re-expanding
        // to a prompt larger than the one that already overflowed.
        activeCommits = overflowCommits
        activeFiles = overflowFiles
        activeOverflowBudget = overflowBudget
        // Capture the overflow error detail for downstream error messages.
        // If step 7 later fails (e.g. strict-retry returns malformed JSON), this
        // string is appended to core.setFailed so the full error chain is visible
        // in the Actions log — not just the final format-parse failure.
        priorOverflowDetail = String(e).slice(0, 200)
        if (overflowCommits.length === 0 && overflowFiles.length === 0) {
          core.warning(
            '[afm] Overflow re-truncation dropped all commits and files — ' +
            'release note will be generated with no diff context. ' +
            'This can happen when individual commit messages or filenames are extremely long.'
          )
        }
        core.info(`[afm] Overflow-retry prompt: ${smallerPrompt.length} chars (budget: ${overflowBudget})`)
        try {
          raw = afmCli(afmBin, smallerPrompt, afmOptions)
        } catch (e2) {
          const detail = String(e2)
          throw new Error(
            `[afm] Overflow-retry failed (binary: ${afmBin}): ${detail}. ` +
            `Original overflow: ${String(e).slice(0, 200)}`
          )
        }
      } else {
        // Cold-start / transient error — wait 15s and retry with the original prompt.
        // Canary: if the error string mentions context/token/window but isContextOverflowError
        // did not match, the Apple enum may have been renamed — update isContextOverflowError
        // and see runbot-hq/afm-cli#2 for structured exit code tracking.
        core.debug(`[afm] Cold-start branch — error did not match isContextOverflowError: ${String(e).slice(0, 200)}`)
        core.info('[afm] Attempt 1 failed — retrying in 15s (cold-start model load)...')
        await new Promise(r => setTimeout(r, 15_000))
        try {
          raw = afmCli(afmBin, prompt, afmOptions)
        } catch (e2) {
          const detail = String(e2)
          throw new Error(
            `[afm] Cold-start retry failed (binary: ${afmBin}): ${detail}. ` +
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
    // ║            (Math.min(MAX_PROMPT_CHARS, activeOverflowBudget)         ║
    // ║            - strictSuffix.length) so the suffix is guaranteed to fit ║
    // ║            and the prompt never exceeds the tightest budget seen.    ║
    // ║  DOES NOT: get a 15s pause+retry loop (see WHY below)               ║
    // ║                                                                      ║
    // ║  WHY re-truncate instead of slicing after append?                   ║
    // ║  Slicing (prompt + suffix) to MAX_PROMPT_CHARS amputates the suffix ║
    // ║  whenever prompt is already at the cap — the very instruction meant  ║
    // ║  to fix malformed output gets silently dropped. Re-truncating with   ║
    // ║  a reduced budget guarantees the suffix is always present in full.   ║
    // ║                                                                      ║
    // ║  WHY Math.min(MAX_PROMPT_CHARS, activeOverflowBudget)?              ║
    // ║  If step 6 took the overflow path (activeOverflowBudget < MAX_PROMPT ║
    // ║  _CHARS), the overflow-retry budget was ~9,000 chars. Sending a      ║
    // ║  strict-retry prompt at the default ~11,868-char budget would exceed  ║
    // ║  the window that already overflowed and guarantee a second overflow.  ║
    // ║  Capping to activeOverflowBudget - strictSuffix.length ensures the   ║
    // ║  strict-retry is always at most as large as the last successful call. ║
    // ║  When no overflow occurred, activeOverflowBudget = MAX_PROMPT_CHARS  ║
    // ║  and the cap is a no-op.                                             ║
    // ║                                                                      ║
    // ║  IS PASSING activeCommits/activeFiles (narrowest known-good set) OK? ║
    // ║  Yes. activeCommits/activeFiles are initialised from step 5's        ║
    // ║  usedCommits/usedFiles and updated to overflowCommits/overflowFiles  ║
    // ║  if step 6 took the overflow path. This guarantees step 7 never      ║
    // ║  re-expands to a prompt larger than the one that last succeeded.     ║
    // ║  The ~130-char budget reduction rarely drops even one item; when it  ║
    // ║  does, the halving loop removes it correctly. Not a bug.             ║
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
      // truncatePromptToFit with charBudget = Math.min(MAX_PROMPT_CHARS,
      // activeOverflowBudget) - strictSuffix.length, so the returned prompt is
      // guaranteed to leave room for the full suffix and never exceeds the tightest
      // budget seen (activeOverflowBudget when the overflow path was taken).
      // strictSuffix is then appended unconditionally.
      const strictBudget = Math.min(MAX_PROMPT_CHARS, activeOverflowBudget) - strictSuffix.length
      const { prompt: strictBase } = truncatePromptToFit(
        safeTag, safePrevTag, activeCommits, activeFiles, promptExtra,
        strictBudget
      )
      const strictPrompt = strictBase + strictSuffix
      core.info(`[afm] Strict-retry prompt: ${strictPrompt.length} chars (budget: ${strictBudget} + ${strictSuffix.length} suffix)`)
      try {
        raw = afmCli(afmBin, strictPrompt, afmOptions)
      } catch (e2) {
        const detail = String(e2)
        const isOverflow2 = isContextOverflowError(e2)
        throw new Error(
          `[afm] Strict-prompt retry failed (binary: ${afmBin}): ${detail}. ` +
          (isOverflow2
            ? 'Context window overflow on strict-retry — token density is too high even at the reduced budget. ' +
              `Strict-retry budget: ${strictBudget} + ${strictSuffix.length} suffix chars.`
            : 'If this is ETIMEDOUT, the model may need more than 60s to load on first run — ' +
              'consider increasing the timeout or pre-warming the runner.') +
          (priorOverflowDetail ? ` Prior overflow (step 6): ${priorOverflowDetail}` : '')
        )
      }
      // If strict-retry returned output but it still fails to parse, propagate
      // with prior overflow context attached so the full chain is visible.
      try {
        result = parseAfmOutput(raw, tag)
      } catch (e3) {
        throw new Error(
          `[afm] Strict-retry output still malformed: ${String(e3).slice(0, 300)}.` +
          (priorOverflowDetail ? ` Prior overflow (step 6): ${priorOverflowDetail}` : '')
        )
      }
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
