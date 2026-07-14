#!/usr/bin/env bash
set -euo pipefail

OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"

# 1. Shallow clone guard — git tag requires full tag history
# --unshallow is intentional and required: --tags alone on a shallow repo fetches tag refs
# but leaves the commits they point to unreachable, breaking git log/describe between tags.
# The caller workflow already sets fetch-depth: 0, so this guard is defensive-only for
# callers that forget. Do NOT revert to --tags without --unshallow.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  echo "::warning::Shallow clone detected — unshallowing to fetch full tag history"
  git fetch --unshallow --tags --quiet
fi

# 2. Resolve TAG — auto-fill latest if blank, then validate it exists in the repo.
# workflow_dispatch default: '' means TAG may arrive empty when the user leaves the
# field blank. Auto-resolving to the latest semver tag gives pre-fill UX without
# requiring a static default in the YAML. If TAG is set but does not exist as a git
# tag, we fail early with a clear message rather than letting gh api return a 404.
if [ -z "${TAG:-}" ]; then
  TAG=$(git tag --sort=-version:refname | head -n 1)
  if [ -z "$TAG" ]; then
    echo "::error::No tags found in repository — cannot auto-resolve TAG."
    exit 1
  fi
  echo "[afm] TAG not provided — auto-resolved to latest: $TAG"
fi

# Tag slash guard — must run before git rev-parse so a caller passing
# refs/tags/v1.0.0 gets the clear ::error:: annotation, not a confusing
# "does not exist" message from rev-parse.
[[ "$TAG" =~ / ]] && { echo '::error::TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path'; exit 1; }

if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "::error::TAG '$TAG' does not exist in this repository. Check the tag name and try again."
  exit 1
fi

# 3. Resolve prev_tag from git tags
# version:refname sort is semver-aware (vN.N.N). This is correct for run-bot's tag
# convention. If non-semver tags are ever introduced (e.g. nightly-*, beta), add a
# grep -E '^v[0-9]' filter before head -n 1 to exclude them from the sort.
if [ -z "${PREV_TAG:-}" ]; then
  PREV_TAG=$(git tag --sort=-version:refname | grep -v "^${TAG}$" | head -n 1)
fi

if [ -z "${PREV_TAG:-}" ]; then
  echo "::warning::No previous tag found — using first commit as baseline"
  PREV_TAG=$(git rev-list --max-parents=0 HEAD)
fi

echo "[afm] Comparing $PREV_TAG → $TAG"

# 4. Fetch diff context (read-only, uses ambient GITHUB_TOKEN)
# GitHub's compare API returns at most 250 commits and 300 files per page (no pagination
# on this endpoint via gh cli --jq). TOTAL_COMMITS / TOTAL_FILES in the step summary
# reflect the API-capped count, not the true range size on very large releases.
# This is cosmetic only — the prompt cap logic (80 commits / 150 files) still operates
# correctly on whatever the API returns. Do NOT add --paginate; the endpoint doesn't
# support it for compare and it would change the response shape.
# timeout 30: the compare API is a single lightweight JSON response. 30s is generous
# for any reasonable network; if it hasn't responded in 30s something is wrong (rate
# limit, DNS failure, GitHub outage) and we should fail fast rather than block the job.

# PREV_TAG slash guard — catches the case where a caller explicitly passes
# prev_tag as a ref path (e.g. refs/tags/v1.2.3). This guard does NOT fire on
# auto-resolved values: `git tag` always emits bare tag names (no slashes), and
# the first-commit SHA fallback (git rev-list --max-parents=0) also never contains
# a slash. The guard is therefore only meaningful for explicit caller input.
[[ "${PREV_TAG:-}" =~ / ]] && { echo '::error::prev_tag contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path'; exit 1; }
CONTEXT=$(timeout 30 gh api "repos/$OWNER/$REPO_NAME/compare/$PREV_TAG...$TAG" \
  --jq '{
    commits: [.commits[].commit.message[:120]],
    files:   [.files[] | .status + " " + .filename],
    total_commits: (.commits | length),
    total_files:   (.files   | length)
  }') || {
  echo "::error::gh api compare failed (rate limit, bad tags, or network). PREV_TAG=$PREV_TAG TAG=$TAG"
  exit 1
}

TOTAL_COMMITS=$(echo "$CONTEXT" | jq '.total_commits')
TOTAL_FILES=$(echo "$CONTEXT"   | jq '.total_files')

[ "$TOTAL_COMMITS" -gt 80  ] && echo "::warning::$TOTAL_COMMITS commits — prompt capped at 80"
[ "$TOTAL_FILES"   -gt 150 ] && echo "::warning::$TOTAL_FILES files — prompt capped at 150"

# Filter noisy commit messages (fixup!/squash!/WIP) before capping at 80 — they
# pollute the prompt and degrade AFM output quality.
# WIP REGEX: [Ww][Ii][Pp]([ :]|$) catches:
#   "WIP: thing", "WIP thing", "WIP" (bare), "wip:", "wip" (bare)
# The ([ :]|$) alternation is intentional — a bare WIP commit with no separator
# would not be caught by [Ww][Ii][Pp][ :] alone.
CONTEXT=$(echo "$CONTEXT" | jq '{
  commits: [.commits[] | select(test("^(fixup!|squash!|[Ww][Ii][Pp]([ :]|$))") | not)][:80],
  files: .files[:150]
}')

# 5. Build prompt payload
if [ "${#PROMPT_EXTRA}" -gt 300 ]; then
  echo "::warning::prompt_extra truncated to 300 chars (was ${#PROMPT_EXTRA})"
fi
PROMPT_EXTRA_SAFE="${PROMPT_EXTRA:0:300}"
PAYLOAD=$(mktemp "${TMPDIR:-/tmp}/afm_release_XXXXXX.json")

jq -n \
  --arg tag      "$TAG" \
  --arg prev_tag "$PREV_TAG" \
  --argjson ctx  "$CONTEXT" \
  --arg extra    "$PROMPT_EXTRA_SAFE" \
  '{
    raw_prompt: (
      "Generate GitHub release notes as JSON with exactly two keys: \"title\" and \"body\".\n" +
      "Rules:\n" +
      "- title: include the version tag (" + $tag + ") and a short human-readable summary.\n" +
      "- body: Markdown with sections ## Added, ## Changed, ## Fixed, ## Removed, ## Security (omit empty sections).\n" +
      "- User-facing language, past tense.\n" +
      "- Skip bot commits (dependabot, renovate, github-actions) and merge commits.\n" +
      "- Each commit message truncated to 120 chars.\n" +
      "- Output JSON only — no markdown fences, no extra keys.\n\n" +
      "Previous tag: " + $prev_tag + "\n" +
      "Target tag: " + $tag + "\n\n" +
      "Commits:\n" + ($ctx.commits | map("- " + .) | join("\n")) + "\n\n" +
      "Changed files:\n" + ($ctx.files | map("- " + .) | join("\n")) +
      (if $extra != "" then "\n\nExtra instructions: " + $extra else "" end)
    ),
    intent:     "release",
    request_id: $tag,
    created_at: (now | todate)
  }' > "$PAYLOAD"

# 6. Call AFM sidecar — retry 2×60s with sleep between for cold-start model loading
#
# DESIGN: Why __AFM_FATAL__ sentinel instead of exit 1?
# `exit 1` inside a $() command substitution only exits the subshell — bash does NOT
# propagate it to the outer script even with set -e. The sentinel echoes a known string
# to stdout (captured into RAW), which the outer script then checks and exits on.
# Both the MDM/fatal path AND the retry-exhausted path emit `echo "__AFM_FATAL__"` —
# there is NO bare `exit 1` inside the $() block. Do NOT replace with exit 1.
# The retry warning goes to stderr (>&2) so it is NOT captured into RAW.
# The string equality check `[ "$RAW" = "__AFM_FATAL__" ]` is intentional — any node
# stdout prefix before a crash would mean RAW != sentinel, which falls through to the
# empty-output check in step 6 and surfaces as a warning, not a silent pass.
# NOTE: The exit 1 in step 4 (gh api compare failure) is OUTSIDE $() and is correct.
AFM_ERR=$(mktemp "${TMPDIR:-/tmp}/afm_err_XXXXXX.txt")

run_afm() {
  timeout 60 node "$AFM_SIDECAR_DIST" --payload "$PAYLOAD" 2>"$AFM_ERR"
}

RAW=$(
  run_afm || {
    if grep -qiE "(mdm|not authorized|permission denied|not available)" "$AFM_ERR"; then
      echo "::error::AFM fatal error (not retrying): $(cat $AFM_ERR)"
      rm -f "$PAYLOAD" "$AFM_ERR"
      echo "__AFM_FATAL__"
    else
      echo "[afm] Attempt 1 failed — retrying in 15s (cold-start model load)..." >&2
      sleep 15
      timeout 60 node "$AFM_SIDECAR_DIST" --payload "$PAYLOAD" 2>>"$AFM_ERR" || {
        echo "::error::AFM failed after 2 attempts. Stderr: $(cat $AFM_ERR)"
        rm -f "$PAYLOAD" "$AFM_ERR"
        echo "__AFM_FATAL__"
      }
    fi
  }
)
if [ "$RAW" = "__AFM_FATAL__" ]; then exit 1; fi
# PAYLOAD and AFM_ERR cleanup: rm is called here (outside $()) rather than via trap
# because both files are also rm'd inside the $() subshell on the fatal paths. A trap
# on the outer shell would double-remove on the fatal path (harmless but noisy) and
# more importantly the subshell rm IS effective — rm operates on the filesystem path
# directly, not on a copied variable, so the file is gone by the time we reach here
# on the fatal path. On the success path we clean up here. rm -f is safe either way.
rm -f "$PAYLOAD" "$AFM_ERR"

# Strip markdown code fences AFM sometimes wraps around JSON output.
# AFM occasionally ignores the "Output JSON only — no markdown fences" instruction
# and wraps the response in ```json ... ``` or ``` ... ```. This strips leading/trailing
# fences so jq can parse clean JSON without triggering the fallback path.
#
# WHY THREE SEPARATE sed PASSES (not one expression):
# `printf '%s' "$RAW"` feeds the full multi-line string to sed. POSIX sed processes each
# line independently — `^` anchors to the start of each line, `$` to the end of each
# line. This means the first two passes strip any line that consists only of a fence
# opener (not just the very first line of the blob). That is intentional: if AFM emits
# a stray ```json line mid-body, it is stripped too. Same for the closing ``` pass.
# This is broader than "strip the leading fence" — it is "strip any fence-only line".
# Do NOT collapse to a single -e expression; the three-pass order matters because a
# ```json line must be matched by pass 1 before pass 2 would match its bare ``` residue.
# Pass 3 uses a full-line anchor (^...$) so it only strips lines that consist ENTIRELY
# of optional whitespace + ``` + optional whitespace. This avoids stripping ``` that
# appears at the end of a line with other content (e.g. prose like "Use ```").
# WHY TWO SEPARATE sed PASSES (not one expression):
# `printf '%s' "$RAW"` feeds the full multi-line string to sed. POSIX sed processes each
# line independently — `^` anchors to the start of each line, `$` to the end of each
# line. Both passes use full-line anchors (^[[:space:]]*...[[:space:]]*$) so they only
# fire on lines that consist ENTIRELY of the fence pattern — never on lines in the body
# that merely start with triple backticks (e.g. a code block opener like "```bash ...").
#
# Pass 1: strip any fence-only line that starts with ```json (language-tagged opener).
#         Must run first — pass 2's bare-fence pattern would also match ```json lines,
#         so pass 1 must consume them before pass 2 sees the string.
# Pass 2: strip any remaining fence-only line (bare ``` opener, or closing fence).
#         Catches: the residue after pass 1 if AFM emits ```json on its own line,
#         standalone ``` openers with no language tag, and all closing ``` fences.
#
# All patterns are full-line anchored. Do NOT simplify to a prefix strip like
# `s/^```[[:space:]]*//` — that would mangle "```bash" lines in body code blocks
# by leaving "bash" as a dangling word on the line.
RAW=$(printf '%s' "$RAW" | sed 's/^[[:space:]]*```json[[:space:]]*$//' | sed 's/^[[:space:]]*```[[:space:]]*$//')

# 7. Parse — fallback to raw if AFM returns prose instead of JSON
# USED_FALLBACK is set here at the actual decision point and reused in step 9 summary.
# Do NOT re-derive fallback status from RAW in step 9 via jq — RAW may have been
# partially parsed or truncated by then, and re-checking would be inconsistent.
#
# DOUBLE-PARSE IDIOM: `if type=="string" then fromjson else . end`
# AFM occasionally returns the JSON object double-encoded — i.e. the entire JSON
# object serialised as a JSON string (e.g. "{\"title\":\"...\"}" with outer quotes).
# The `if type=="string" then fromjson` branch handles that case by parsing once more.
# The `else .` branch handles the normal case where AFM returns a plain JSON object.
# `// empty` produces an empty string (not null/false) so the -z checks below work.
# The `2>/dev/null || true` suppresses jq errors when RAW is unparseable prose —
# those cases are caught by the -z TITLE/-z BODY fallback block immediately below.
USED_FALLBACK=0
TITLE=$(echo "$RAW" | jq -r 'if type=="string" then fromjson else . end | .title // empty' 2>/dev/null || true)
BODY=$(echo  "$RAW" | jq -r 'if type=="string" then fromjson else . end | .body  // empty' 2>/dev/null || true)

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  USED_FALLBACK=1
  echo "::warning::AFM did not return valid JSON — falling back to raw output. Check the Log outputs step and consider tuning the prompt."
  TITLE=$(echo "$RAW" | head -n 1 | cut -c1-100)
  BODY="$RAW"
fi

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  echo "::error::AFM returned empty output."
  exit 1
fi

# 8. Cap body length — GitHub Releases supports ~125k chars; 120k gives a safe margin.
# GitHub Actions output itself has no hard per-value limit that would be hit at this size.
if [ "${#BODY}" -gt 120000 ]; then
  echo "::warning::Generated body exceeds 120000 chars — truncating"
  BODY="${BODY:0:120000}"
fi

echo "[afm] Generated: $TITLE"

# 9. Write outputs (random delimiter prevents body content collision)
# ALL THREE outputs (release_title, prev_tag, release_body) use the heredoc <<DELIM form.
# Do NOT simplify release_title or prev_tag to bare `echo "key=value"` — AFM output could
# theoretically contain a newline, which would silently corrupt $GITHUB_OUTPUT.
OUTPUT_DELIM="AFM_OUT_$(openssl rand -hex 8)"
{
  echo "release_title<<${OUTPUT_DELIM}"
  echo "$TITLE"
  echo "${OUTPUT_DELIM}"
  echo "prev_tag<<${OUTPUT_DELIM}"
  echo "$PREV_TAG"
  echo "${OUTPUT_DELIM}"
  echo "release_body<<${OUTPUT_DELIM}"
  echo "$BODY"
  echo "${OUTPUT_DELIM}"
} >> "$GITHUB_OUTPUT"

# 10. Step Summary
FALLBACK_NOTE=""
[ "$USED_FALLBACK" = "1" ] && FALLBACK_NOTE=" ⚠️ Fallback output (raw prose)"
{
  echo "## 📝 Release Notes: $TAG${FALLBACK_NOTE}"
  echo ""
  echo "**Title:** $TITLE"
  echo "**Compared:** \`$PREV_TAG\` → \`$TAG\` ($TOTAL_COMMITS commits, $TOTAL_FILES files)"
  echo "**Runner:** ${RUNNER_NAME} | macOS $(sw_vers -productVersion) | Node $(node --version)"
  echo ""
  echo "$BODY"
} >> "$GITHUB_STEP_SUMMARY"

echo "[afm] Done."
