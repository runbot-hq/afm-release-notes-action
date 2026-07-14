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

# 2. Resolve prev_tag from git tags
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

# 3. Fetch diff context (read-only, uses ambient GITHUB_TOKEN)
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

CONTEXT=$(echo "$CONTEXT" | jq '{commits: .commits[:80], files: .files[:150]}')

# 4. Build prompt payload
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

# 5. Call AFM sidecar — retry 2×60s with sleep between for cold-start model loading
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
# NOTE: The exit 1 at line ~41 (gh api compare failure) is OUTSIDE $() and is correct.
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
      echo "[afm] Attempt 1 failed — retrying in 5s..." >&2
      sleep 5
      timeout 60 node "$AFM_SIDECAR_DIST" --payload "$PAYLOAD" 2>>"$AFM_ERR" || {
        echo "::error::AFM failed after 2 attempts. Stderr: $(cat $AFM_ERR)"
        rm -f "$PAYLOAD" "$AFM_ERR"
        echo "__AFM_FATAL__"
      }
    fi
  }
)
if [ "$RAW" = "__AFM_FATAL__" ]; then exit 1; fi
rm -f "$PAYLOAD" "$AFM_ERR"

# 6. Parse — fallback to raw if AFM returns prose instead of JSON
# USED_FALLBACK is set here at the actual decision point and reused in step 9 summary.
# Do NOT re-derive fallback status from RAW in step 9 via jq — RAW may have been
# partially parsed or truncated by then, and re-checking would be inconsistent.
USED_FALLBACK=0
TITLE=$(echo "$RAW" | jq -r 'if type=="string" then fromjson else . end | .title // empty' 2>/dev/null || true)
BODY=$(echo  "$RAW" | jq -r 'if type=="string" then fromjson else . end | .body  // empty' 2>/dev/null || true)

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  USED_FALLBACK=1
  echo "::warning::AFM did not return valid JSON — falling back to raw output"
  TITLE=$(echo "$RAW" | head -n 1 | cut -c1-100)
  BODY="$RAW"
fi

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  echo "::error::AFM returned empty output."
  exit 1
fi

# 7. Cap body length — GitHub Actions output limit guard
if [ "${#BODY}" -gt 65000 ]; then
  echo "::warning::Generated body exceeds 65000 chars — truncating"
  BODY="${BODY:0:65000}"
fi

echo "[afm] Generated: $TITLE"

# 8. Write outputs (random delimiter prevents body content collision)
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

# 9. Step Summary
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
