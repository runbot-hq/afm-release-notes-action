import * as core from '@actions/core'
import * as github from '@actions/github'
import { execSync } from 'child_process'
import * as fs from 'fs'
import { git } from './git'
import { ensureBinary } from './binary'
import { afmCli, isFatalAfmError } from './afm'
import { parseAfmOutput, MAX_PROMPT_CHARS, buildPrompt, truncatePromptToFit } from './prompt'

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
