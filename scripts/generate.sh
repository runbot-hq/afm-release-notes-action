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

# Tag slash guard — a caller passing refs/tags/v1.0.0 instead of v1.0.0 would silently
# produce a broken gh api URL. Fail fast with a clear message instead.
[[ "$TAG" =~ / ]] && { echo '::error::TAG contains a slash — pass a plain tag name (e.g. v1.2.3), not a ref path'; exit 1; }
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
CONTEXT=$(echo "$CONTEXT" | jq '{
  commits: [.commits[] | select(test("^(fixup!|squash!|[Ww][Ii][Pp][ :])") | not)][:80],
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
rm -f "$PAYLOAD" "$AFM_ERR"

# Strip markdown code fences AFM sometimes wraps around JSON output.
# AFM occasionally ignores the "Output JSON only — no markdown fences" instruction
# and wraps the response in ```json ... ``` or ``` ... ```. This strips leading/trailing
# fences so jq can parse clean JSON without triggering the fallback path.
RAW=$(printf '%s' "$RAW" | sed 's/^```json[[:space:]]*//' | sed 's/^```[[:space:]]*//' | sed 's/[[:space:]]*```$//')

# 7. Parse — fallback to raw if AFM returns prose instead of JSON
# USED_FALLBACK is set here at the actual decision point and reused in step 9 summary.
# Do NOT re-derive fallback status from RAW in step 9 via jq — RAW may have been
# partially parsed or truncated by then, and re-checking would be inconsistent.
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
