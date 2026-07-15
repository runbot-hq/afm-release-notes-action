# afm-release-notes-action

Generate AI release notes using Apple Intelligence (on-device AFM) on a self-hosted macOS runner. No cloud API, no tokens, no third-party dependencies — runs entirely on-device via a native Swift binary.

**Pure notes-generator.** Given a tag, returns AI-generated `release_title`, `release_body`, and `prev_tag`. What you do with the output is entirely up to the caller.

---

## How It Works

```
action.yml        node20 action — main: dist/index.js
src/index.ts      TypeScript business logic (bundled to dist/index.js via ncc)
afm-cli           Prebuilt Swift binary — thin pass-through to FoundationModels
```

`src/index.ts` handles all logic: tag resolution, GitHub API diff fetch, prompt assembly, retry, and output parsing. `afm-cli` is domain-ignorant — it takes `--prompt <text>` and returns plain text. Both are committed as build artifacts; no build step runs on the runner.

---

## Inputs

| Input | Required | Default | Description |
| :-- | :--: | :-- | :-- |
| `tag` | ✅ | — | Tag to generate release notes for (e.g. `v1.2.3`) |
| `prev_tag` | ❌ | auto | Previous tag to compare against (auto-resolved from git tags if omitted) |
| `prompt_extra` | ❌ | — | Optional extra instruction appended to the prompt (max 300 chars) |
| `debug` | ❌ | `false` | Set to `true` to enable verbose debug logging |

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
- uses: runbot-hq/afm-release-notes-action@v1
  id: notes
  env:
    GITHUB_TOKEN: ${{ github.token }}
  with:
    tag: ${{ github.ref_name }}
```

### With outputs

> **Injection safety:** `release_title` and `release_body` are LLM-generated. Pass them
> via `env:` rather than interpolating `${{ }}` directly into shell, and write the body
> to a temp file for `--notes-file` to avoid word-splitting on quotes, backticks, or `$()`.

```yaml
- uses: runbot-hq/afm-release-notes-action@v1
  id: notes
  env:
    GITHUB_TOKEN: ${{ github.token }}
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

### Using `prev_tag`

`prev_tag` is useful when you want GitHub's comparison URL to span exactly the same range the action used:

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

### Full caller workflow

```yaml
name: Release Notes
on:
  release:
    types: [published]

permissions:
  contents: read  # required for GitHub API diff fetch

jobs:
  generate-notes:
    runs-on: [self-hosted, macOS, apple-intelligence]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required — shallow clone breaks tag resolution

      - uses: runbot-hq/afm-release-notes-action@v1
        id: notes
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          tag: ${{ github.ref_name }}

      - name: Log outputs
        run: |
          echo "Title: ${{ steps.notes.outputs.release_title }}"
          echo "Prev tag: ${{ steps.notes.outputs.prev_tag }}"
```

---

## Runner Requirements

- Apple Silicon Mac, macOS 26+, Apple Intelligence enabled in System Settings (per-user — check MDM restrictions)
- Runner labeled `[self-hosted, macOS, apple-intelligence]`
- No other dependencies — `afm-cli` and `dist/index.js` are committed; nothing is installed at runtime

> `actions/checkout` must use `fetch-depth: 0` — a shallow clone will fail tag resolution.

---

## Known Constraints

- **Apple Intelligence is per-user** — may be blocked by MDM. The action fails fast with a clear error message including the runner name.
- **AFM retried once** — 2 × 60s with a 15s pause between attempts; handles cold-start model loading. Fatal errors (MDM block, AI unavailable, permission denied) skip the retry immediately.
- **Strict-prompt retry** — if the model returns malformed JSON, the action retries once with a stricter prompt before failing.
- **`prompt_extra` capped at 300 chars** — prevents context bloat.
- **`release_body` capped at 120,000 chars** — GitHub Releases supports ~125k chars; the cap leaves headroom.
- **`GITHUB_TOKEN` must be passed via `env:`** — the action reads it from the environment, not as a declared input.
- **`@v1` floating tag** — moves on every patch. Breaking changes bump to `v2`.

---

## Rebuilding Artifacts

`afm-cli` and `dist/index.js` are committed build artifacts. They only need to be rebuilt when the source changes:

```bash
# Swift binary (requires self-hosted macOS 26 runner)
cd afm-cli && swift build -c release
cp .build/release/afm-cli ..

# TypeScript bundle
npm install && npm run build

git add afm-cli dist/index.js
git commit -m "chore: build artifacts"
```

A CI workflow (`.github/workflows/check-artifacts.yml`) verifies both files are present on every push to `main` and fails the run if either is missing.
