# afm-release-notes-action

Generate AI release notes using Apple Intelligence (on-device AFM) on a self-hosted macOS runner. No cloud API, no tokens, no third-party dependencies — runs entirely on-device via a native Swift binary.

**Pure notes-generator.** Given a tag, returns AI-generated `release_title`, `release_body`, and `prev_tag`. What you do with the output is entirely up to the caller.

---

## How It Works

```
action.yml        composite action — downloads afm-cli-bin, then runs dist/index.js
src/index.ts      TypeScript business logic (bundled to dist/index.js via ncc)
afm-cli-bin       Prebuilt Swift binary — downloaded at runtime from runbot-hq/afm-cli@v1
```

`src/index.ts` handles all logic: tag resolution, GitHub API diff fetch, prompt assembly, retry, and output parsing. `afm-cli-bin` is domain-ignorant — it takes `--prompt <text>` and returns plain text.

`afm-cli-bin` is published as a release asset in [runbot-hq/afm-cli](https://github.com/runbot-hq/afm-cli) and downloaded at runtime by `action.yml` (pinned to the `v1` floating tag). `dist/index.js` is committed as a build artifact by CI; no build step runs on the runner.

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
- `gh` CLI available on the runner (standard on GitHub-hosted and most self-hosted runners) — used to download `afm-cli-bin` at runtime from [runbot-hq/afm-cli@v1](https://github.com/runbot-hq/afm-cli)
- `dist/index.js` is committed as a build artifact; no build step runs on the runner

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

`dist/index.js` is a committed build artifact, automatically rebuilt by `.github/workflows/build-artifacts.yml` on every push to `main`. To rebuild manually:

```bash
# TypeScript bundle
npm install && npm run build

git add dist/
git commit -m "chore: rebuild artifacts"
```

> `git add dist/` not `dist/index.js` — ncc emits `dist/sourcemap-register.js` as a
> required sibling. Staging only `dist/index.js` will cause a `MODULE_NOT_FOUND` crash
> at runtime.

`afm-cli-bin` is published and maintained in [runbot-hq/afm-cli](https://github.com/runbot-hq/afm-cli). To rebuild it, push to `main` in that repo — CI will rebuild and re-upload the release asset automatically.

---

## macOS 27+ Migration Path

macOS 27 ships a built-in `fm` CLI that calls Foundation Models directly from the terminal with no build step required:

```bash
fm respond "Your prompt here"
```

When your self-hosted runner upgrades to macOS 27, this action can be simplified to delegate to `fm` instead of `afm-cli-bin` — eliminating the committed Swift binary entirely. The TypeScript orchestration layer (`dist/index.js`) remains unchanged; only the final inference call changes.

**Until then:** `afm-cli-bin` is the correct path on macOS 26. `fm` is not available on macOS 26.

Tracked in [#28](https://github.com/runbot-hq/afm-release-notes-action/issues/28).

---

## Roadmap

- [#26](https://github.com/runbot-hq/afm-release-notes-action/issues/26) — Extract `afm-cli` Swift binary to its own repo for reuse across actions
- [#28](https://github.com/runbot-hq/afm-release-notes-action/issues/28) — macOS 27 `fm` CLI integration
- [#24](https://github.com/runbot-hq/afm-release-notes-action/issues/24) — Replace `firstIndex(of:)` arg parser with two-pass parser in `afm-cli`
- [#9](https://github.com/runbot-hq/afm-release-notes-action/issues/9) — `prompt_override` input to replace base prompt entirely
