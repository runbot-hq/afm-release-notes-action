import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  // { shell: true } is intentional: several callers use shell pipes
  // (e.g. | head -n 1, | grep -v) for tag resolution. All cmd values
  // are constructed from validated constants, never from user input.
  // Do NOT replace with execFileSync — the pipe operator requires a shell.
  return execSync(`git ${cmd}`, { encoding: 'utf8', shell: true }).trim()
}

/**
 * Calls afm-cli via spawnSync with an explicit argv array.
 *
 * spawnSync is used instead of execSync deliberately — it passes args
 * directly to the OS without invoking a shell, eliminating any risk of
 * shell metacharacter interpretation in prompt content.
 * Do NOT refactor to execSync with a shell string.
 *
 * Flag names mirror the FoundationModels API exactly (see main.swift):
 *   --prompt                   → session.respond(to:)
 *   --instructions             → Transcript.Instructions (Apple's term for system prompt)
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
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`afm-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return result.stdout.trim()
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
 */
function parseAfmOutput(raw: string): { title: string; body: string } {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim()

  // Format A/B: { title, body } or double-encoded string
  try {
    const parsed = JSON.parse(cleaned)
    const obj = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    if (obj?.title && obj?.body) return { title: String(obj.title), body: String(obj.body) }
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
      return { title: core.getInput('tag') || 'Release', body }
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
    const token = process.env.GITHUB_TOKEN ?? ''
    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')

    // actionPath is the directory where action.yml lives.
    // afm-cli binary is committed there alongside action.yml.
    // GITHUB_ACTION_PATH is set by the runner for all action types including node20.
    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')
    const afmBin = path.join(actionPath, 'afm-cli')

    if (!fs.existsSync(afmBin)) {
      throw new Error(`afm-cli binary not found at ${afmBin}`)
    }

    // debug input gates verbose logging. Setting debug: 'true' in the action
    // call also sets ACTIONS_STEP_DEBUG which core.isDebug() reads natively.
    const debug = core.getInput('debug') === 'true'
    if (debug) core.debug('[afm] Debug logging enabled')

    // 1. Shallow clone guard
    try {
      const isShallow = git('rev-parse --is-shallow-repository')
      if (isShallow === 'true') {
        core.warning('Shallow clone detected — unshallowing to fetch full tag history')
        execSync('git fetch --unshallow --tags --quiet', { stdio: 'inherit' })
      }
    } catch { /* not a git repo edge case */ }

    // 2. Resolve TAG
    let tag = core.getInput('tag').trim()
    if (!tag) {
      tag = git('tag --sort=-version:refname | head -n 1')
      if (!tag) throw new Error('No tags found in repository — cannot auto-resolve TAG.')
      core.info(`[afm] TAG not provided — auto-resolved to latest: ${tag}`)
    }
    if (tag.includes('/')) throw new Error('TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path')
    try { git(`rev-parse ${tag}`) } catch { throw new Error(`TAG '${tag}' does not exist in this repository.`) }

    // 3. Resolve PREV_TAG
    let prevTag = core.getInput('prev_tag').trim()
    if (!prevTag) {
      prevTag = git(`tag --sort=-version:refname | grep -v "^${tag}$" | head -n 1`)
    }
    if (!prevTag) {
      core.warning('No previous tag found — using first commit as baseline')
      prevTag = git('rev-list --max-parents=0 HEAD')
    }
    if (prevTag.includes('/')) throw new Error('prev_tag contains a slash — pass a plain tag name')
    core.info(`[afm] Comparing ${prevTag} → ${tag}`)

    // 4. Fetch diff context via GitHub API
    const octokit = github.getOctokit(token)
    const compare = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo: repoName,
      basehead: `${prevTag}...${tag}`,
    })

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
    const promptExtra = core.getInput('prompt_extra').slice(0, 300)

    const instructions = 'You are a technical writer generating GitHub release notes. Always respond with valid JSON only — no markdown fences, no prose, no extra keys. Output exactly: {"title": "...", "body": "..."}'

    const prompt = [
      'Generate GitHub release notes as JSON with exactly two keys: "title" and "body".',
      'Rules:',
      `- title: include the version tag (${tag}) and a short human-readable summary.`,
      '- body: Markdown with sections ## Added, ## Changed, ## Fixed, ## Removed, ## Security (omit empty sections).',
      '- User-facing language, past tense.',
      '- Skip bot commits (dependabot, renovate, github-actions) and merge commits.',
      '- Output JSON only — no markdown fences, no extra keys.',
      '',
      `Previous tag: ${prevTag}`,
      `Target tag: ${tag}`,
      '',
      'Commits:',
      ...commits.map(c => `- ${c}`),
      '',
      'Changed files:',
      ...files.map(f => `- ${f}`),
      ...(promptExtra ? ['', `Extra instructions: ${promptExtra}`] : []),
    ].join('\n')

    const afmOptions = {
      instructions,
      temperature: 0.7,
      maximumResponseTokens: 2048,
    }

    // 6. Call afm-cli — retry once on cold-start failure (model not yet loaded)
    core.info('[afm] Calling afm-cli...')
    let raw: string
    try {
      raw = afmCli(afmBin, prompt, afmOptions)
    } catch (e) {
      core.info('[afm] Attempt 1 failed — retrying in 15s (cold-start model load)...')
      await new Promise(r => setTimeout(r, 15_000))
      raw = afmCli(afmBin, prompt, afmOptions)
    }

    if (!raw) throw new Error('afm-cli returned empty output')

    // 7. Parse output.
    // parseAfmOutput throws on unrecognised output (format D) — that throw
    // is what makes this retry branch reachable. Do NOT make parseAfmOutput
    // return silently on prose fallback or this catch block becomes dead code.
    let result: { title: string; body: string }
    try {
      result = parseAfmOutput(raw)
    } catch (e) {
      core.warning(`Output malformed — retrying with stricter prompt: ${e}`)
      const strictPrompt = `${prompt}\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No text before or after. No markdown. Exactly: {"title": "string", "body": "string"}`
      raw = afmCli(afmBin, strictPrompt, afmOptions)
      result = parseAfmOutput(raw) // throws and fails the action if still malformed
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
