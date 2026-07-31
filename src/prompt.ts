import * as core from '@actions/core'

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
export const PARSE_FAILED = Symbol('PARSE_FAILED')

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
 * Sentinel: PARSE_FAILED is declared at module scope (above this function).
 * Symbol() creates a new unique object on every call — a per-call declaration
 * would work within a single invocation but is fragile across refactors.
 * See the module-level comment above the PARSE_FAILED declaration for the full
 * rationale. Do NOT move PARSE_FAILED back inside this function.
 *
 * Format C element coercion: obj[s] is cast via String(l) rather than a
 * `l: string` type annotation. Array.isArray guards array presence but not
 * element types — a model returning { "Added": [1, 2, 3] } passes the guard
 * and the type annotation silently accepts numbers. String() coercion makes
 * the output correct regardless of element type. Do NOT revert to `l: string`.
 *
 * Second parseAfmOutput call (after strict-prompt retry in run() step 7):
 * if it throws, the error propagates directly to the outer catch in run() and
 * surfaces via core.setFailed. This is intentional — two consecutive parse
 * failures mean the model is not following the format instruction and a third
 * attempt is unlikely to help. No additional try/catch is needed here.
 * Do NOT wrap the second call in another try/catch.
 */
export function parseAfmOutput(raw: string, currentTag: string): { title: string; body: string } {
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')  // /m required — $ must anchor to end-of-line, not end-of-string
    .trim()

  // PARSE_FAILED is module-scoped — see declaration above and JSDoc above.
  // Do NOT re-declare PARSE_FAILED inside this function.
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

/**
 * Assembles the prompt string from its components.
 *
 * Called by the preflight loop in run() on every halving iteration — keep it cheap.
 *
 * safeTag/safePrevTag must already have control chars stripped (\x00-\x1f\x7f)
 * before being passed here — they are embedded directly into the template.
 */
export function buildPrompt(
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
