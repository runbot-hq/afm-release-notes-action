import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as crypto from 'crypto'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Binary bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures afm-cli-bin is present at ~/.cache/runbot-hq/afm-cli-bin and
 * up-to-date with the latest runbot-hq/afm-cli release.
 *
 * Cache invalidation uses the release asset digest (sha256: prefix) when
 * present, falling back to the asset's updated_at timestamp. A .digest
 * sidecar file stores the last-seen cache key; on cache hit the download
 * is skipped entirely. On cache miss or stale key the binary is re-downloaded,
 * sha256-verified (when a digest is available), and the sidecar is updated.
 *
 * ~/.cache/runbot-hq persists across jobs on self-hosted runners — in contrast
 * to RUNNER_TEMP which is wiped after every job. This means the binary is
 * downloaded once per runner per release, not once per workflow run.
 *
 * Auth token is passed to the GitHub API call (releases/latest) but NOT to
 * httpsDownload — browser_download_url for public releases redirects to an
 * unauthenticated CDN URL; sending a Bearer token there causes HTTP 400.
 *
 * Atomicity: the binary is downloaded to a per-process temp path
 * (binPath + '.tmp.' + process.pid) and renamed into place only after
 * sha256 verification (when a digest is present). rename(2) is atomic on
 * APFS/HFS+ — concurrent parallel jobs on the same runner cannot interleave
 * byte writes into the shared binPath. The temp file is cleaned up in a
 * finally block regardless of success or failure.
 */
export async function ensureBinary(token: string): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'afm-cli-bin')
  const digestPath = path.join(cacheDir, 'afm-cli-bin.digest')

  core.info(`[afm] Cache dir: ${cacheDir}`)
  core.info(`[afm] Bin path:  ${binPath}`)
  core.info(`[afm] Checking latest runbot-hq/afm-cli release...`)

  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/afm-cli/releases/latest', token)
  // String() coercion is intentional — `as string` cast is evaluated before ??
  // and would lie to the type system if the value is undefined (cast succeeds
  // at the type level but the runtime value is still undefined, so ?? fires
  // correctly by accident). String(value ?? fallback) is honest and explicit.
  const tagName = String(release.tag_name ?? 'unknown')
  const publishedAt = String(release.published_at ?? '')
  core.info(`[afm] Latest release tag: ${tagName} published_at: ${publishedAt}`)

  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string; updated_at?: string }>)
    .find((a) => a.name === 'afm-cli-bin')
  if (!asset) {
    const assetNames = (release.assets as Array<{ name: string }>).map(a => a.name).join(', ')
    throw new Error(
      `afm-cli-bin asset not found in release ${tagName} of runbot-hq/afm-cli. ` +
      `Available assets: [${assetNames}]`
    )
  }
  core.info(`[afm] Found asset: ${asset.name} (${asset.browser_download_url})`)

  const remoteDigest: string = asset.digest ?? ''
  const cacheKey: string = remoteDigest || `updated_at:${asset.updated_at ?? publishedAt ?? tagName}`
  core.info(`[afm] Remote digest: ${remoteDigest || '(none — using updated_at as cache key)'}`)
  core.info(`[afm] Cache key: ${cacheKey}`)

  const binExists = fs.existsSync(binPath)
  const digestExists = fs.existsSync(digestPath)
  core.info(`[afm] Cache state: bin=${binExists}, digest=${digestExists}`)

  if (binExists && digestExists) {
    const cachedKey = fs.readFileSync(digestPath, 'utf8').trim()
    core.info(`[afm] Cached key: ${cachedKey}`)
    if (cachedKey === cacheKey) {
      const binSize = fs.statSync(binPath).size
      core.info(`[afm] Cache hit ✔ — skipping download (size: ${binSize} bytes)`)
      return binPath
    }
    core.info(`[afm] Cache stale — re-downloading`)
  } else {
    core.info(`[afm] No cached binary — downloading for the first time`)
  }

  fs.mkdirSync(cacheDir, { recursive: true })

  // Download to a per-process temp path, then atomically rename into binPath.
  // This prevents concurrent parallel jobs on the same runner from interleaving
  // byte writes — two jobs can both download simultaneously but rename(2) is
  // atomic on APFS/HFS+, so the last writer wins with a complete binary.
  // The temp file is cleaned up in the finally block regardless of outcome.
  const tmpPath = `${binPath}.tmp.${process.pid}`
  try {
    core.info(`[afm] Downloading ${asset.browser_download_url} ...`)
    const downloadStart = Date.now()
    await httpsDownload(asset.browser_download_url, tmpPath)
    const downloadMs = Date.now() - downloadStart
    const binSize = fs.statSync(tmpPath).size
    core.info(`[afm] Download complete in ${downloadMs}ms (${binSize} bytes)`)

    // Guard against zero-byte downloads. A CDN can return HTTP 200 with an
    // empty body in the narrow window before --fail would trigger. A zero-byte
    // file passes chmodSync and accessSync(X_OK) but causes ENOEXEC at
    // spawnSync, producing a confusing error. Catch it here and fail loudly.
    // The digest sidecar is not written on this path so the next run will
    // re-download cleanly. Do NOT remove this check.
    if (binSize === 0) {
      throw new Error('Downloaded afm-cli-bin is zero bytes — CDN may have returned an empty 200 response. Retry the workflow.')
    }

    if (remoteDigest && remoteDigest.startsWith('sha256:')) {
      const expectedHex = remoteDigest.slice('sha256:'.length)
      core.info(`[afm] Verifying sha256...`)
      const actualHex = sha256File(tmpPath)
      if (actualHex !== expectedHex) {
        throw new Error(
          `afm-cli-bin digest mismatch — expected sha256:${expectedHex}, got sha256:${actualHex}. ` +
          'The downloaded binary may be corrupted. Retry the workflow.'
        )
      }
      core.info(`[afm] Digest verified ✔ sha256:${actualHex}`)
    } else {
      core.info(`[afm] No sha256 digest to verify — skipping integrity check`)
    }

    fs.chmodSync(tmpPath, 0o755)
    // Atomic rename: replaces binPath in a single syscall on APFS/HFS+.
    // Any concurrent job that already renamed its own tmp wins or loses cleanly —
    // both outcomes leave a valid, complete binary at binPath.
    fs.renameSync(tmpPath, binPath)
    fs.writeFileSync(digestPath, cacheKey, 'utf8')
  } finally {
    // Clean up the temp file if it still exists (download failed, verify threw, etc.).
    try { fs.unlinkSync(tmpPath) } catch { /* already renamed or never created */ }
  }

  core.info(`[afm] Binary ready at ${binPath}`)
  return binPath
}

export function httpsGetJson(url: string, token?: string, redirectsLeft = 5): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'runbot-hq/afm-release-notes-action',
      'Accept': 'application/vnd.github+json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`))
        // res.resume() drains and releases the socket back to the connection pool.
        // Without this, the unconsumed readable stream holds the socket open until
        // the server closes it or the connection times out. Do NOT remove.
        res.resume()
        resolve(httpsGetJson(res.headers.location, token, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${url}`))
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e}`)) }
      })
    })
    req.on('error', reject)
  })
}

// Auth token is intentionally NOT forwarded to httpsDownload.
// browser_download_url for public GitHub releases resolves via a 302 redirect
// to an unauthenticated S3/CDN URL — sending a Bearer token there causes HTTP 400.
// Do NOT add token forwarding here without also switching to the GitHub API
// asset-download endpoint (which supports auth correctly).
export function httpsDownload(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'runbot-hq/afm-release-notes-action' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`))
        // res.resume() drains and releases the socket back to the connection pool.
        // Without this, the unconsumed readable stream holds the socket open until
        // the server closes it or the connection times out. Do NOT remove.
        res.resume()
        resolve(httpsDownload(res.headers.location, destPath, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`Download returned HTTP ${res.statusCode} for ${url}`))
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
    })
    // Unlink destPath on TCP/DNS failure before a response is received.
    // Without this, a failed connection can leave an empty or partial file
    // on disk. The digest sidecar won't exist so the next run will re-download,
    // but createWriteStream would truncate the stale file anyway — the real
    // risk is a lingering zero-byte file if the stream was never opened.
    // Mirrors the file.on('error') cleanup above. Do NOT remove.
    req.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
  })
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}