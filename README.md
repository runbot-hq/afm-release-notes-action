# afm-release-notes-action

Generate AI release notes using Apple Intelligence (on-device AFM) on a self-hosted macOS runner. No cloud API, no tokens — runs entirely on-device via `@meridius-labs/apple-on-device-ai`.

**Pure notes-generator.** Given a tag, returns AI-generated `release_title`, `release_body`, and `prev_tag`. What you do with the output is entirely up to the caller.

---

## Inputs

| Input | Required | Default | Description |
| :-- | :--: | :-- | :-- |
| `tag` | ✅ | — | The tag to generate release notes for |
| `prev_tag` | ❌ | auto | Previous tag to compare against (auto-resolved from git tags if omitted) |
| `prompt_extra` | ❌ | — | Optional extra instruction appended to the prompt (max 300 chars) |
| `debug` | ❌ | `false` | Set to `true` to enable `AFM_DEBUG=1` verbose sidecar logging |

---

## Outputs

| Output | Description |
| :-- | :-- |
| `release_title` | AI-generated release title |
| `release_body` | AI-generated release notes body (Markdown) |
| `prev_tag` | The previous tag used for comparison |

---

## Usage

### Minimal

```yaml
- uses: runbot-hq/afm-release-notes-action@main
  id: notes
  with:
    tag: ${{ github.ref_name }}
```

### With outputs

> **Injection safety:** `release_title` and `release_body` are LLM-generated. Pass them
> via `env:` rather than interpolating `${{ }}` directly into the shell script, and write
> the body to a temp file for `--notes-file` to avoid shell word-splitting on quotes,
> backticks, or `$()` sequences.

```yaml
- uses: runbot-hq/afm-release-notes-action@main
  id: notes
  with:
    tag: ${{ github.ref_name }}

- name: Create release
  env:
    GH_TOKEN: ${{ github.token }}
    AFM_TITLE: ${{ steps.notes.outputs.release_title }}
    AFM_BODY:  ${{ steps.notes.outputs.release_body }}
  run: |
    NOTES_FILE=$(mktemp)
    trap "rm -f '$NOTES_FILE'" EXIT
    printf '%s' "$AFM_BODY" > "$NOTES_FILE"
    gh release create "${{ github.ref_name }}" \
      --title "${AFM_TITLE:-${{ github.ref_name }}}" \
      --notes-file "$NOTES_FILE"
```

### Using `prev_tag` with `gh release create`

`prev_tag` is useful when you want GitHub's auto-generated comparison URL to span exactly the same range the action used:

```yaml
- name: Create release
  env:
    GH_TOKEN: ${{ github.token }}
    AFM_TITLE: ${{ steps.notes.outputs.release_title }}
    AFM_BODY:  ${{ steps.notes.outputs.release_body }}
    PREV_TAG:  ${{ steps.notes.outputs.prev_tag }}
  run: |
    NOTES_FILE=$(mktemp)
    trap "rm -f '$NOTES_FILE'" EXIT
    printf '%s' "$AFM_BODY" > "$NOTES_FILE"
    gh release create "${{ github.ref_name }}" \
      --title "${AFM_TITLE:-${{ github.ref_name }}}" \
      --notes-file "$NOTES_FILE" \
      --notes-start-tag "$PREV_TAG"
```

### Full example with caller workflow

```yaml
name: Release Notes
on:
  release:
    types: [published]

permissions:
  contents: read  # read-only — action only generates notes, does not write releases
                  # If you pass outputs to `gh release edit`, upgrade to contents: write

jobs:
  generate-notes:
    runs-on: [self-hosted, macOS, apple-intelligence]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: runbot-hq/afm-release-notes-action@main
        id: notes
        with:
          tag: ${{ github.ref_name }}

      - name: Log outputs
        run: |
          echo "Title: ${{ steps.notes.outputs.release_title }}"
          echo "Prev tag: ${{ steps.notes.outputs.prev_tag }}"
```

---

## Runner Requirements

- Apple Silicon Mac, macOS 15+, Apple Intelligence enabled in System Settings (per-user — check MDM restrictions)
- Node 22+
- `gh` CLI, `jq`, and `coreutils` (`timeout` — `brew install coreutils`)
- Default `GITHUB_TOKEN` read scope is sufficient
- Runner labeled `[self-hosted, macOS, apple-intelligence]`

> `actions/checkout` must use `fetch-depth: 0` — a shallow clone will fail `prev_tag` resolution.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

---

## Known Constraints

- **Apple Intelligence is per-user** — may be blocked by MDM. Preflight validates a real non-empty response and includes the runner name in the error.
- **AFM retried 2×60s with 15s sleep** — handles cold-start model loading; fatal errors (MDM block, permission denied) skip the retry.
- **`@meridius-labs/apple-on-device-ai` pinned to `1.6.2`** — upgrade explicitly via PR.
- **`dist/` committed** — fallback for cold runners that skip the cache.
- **`prompt_extra` capped at 300 chars** — prevents context bloat.
- **`release_body` capped at 120,000 chars** — GitHub Releases supports ~125k chars; the cap leaves headroom for the API envelope.
- **Random `$GITHUB_OUTPUT` delimiter** — prevents body content collision with heredoc delimiter.
- **`sw_vers` + Node version in Step Summary** — forensic breadcrumb for AFM model version shifts across macOS updates.
- **`@v1` floating tag** — moves on every patch. Breaking changes bump to `v2`.
- **`dist/index.js` must be rebuilt manually** after any change to `afm-sidecar/src/index.ts`. Run `cd afm-sidecar && npm run build` and commit the updated `dist/index.js`. There is no pre-commit hook enforcing this — a stale `dist/` will silently run old code on cold runners that skip the cache.
