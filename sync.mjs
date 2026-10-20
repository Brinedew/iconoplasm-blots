#!/usr/bin/env node
// Keeps this repository a copy of every Iconoplasm blot, so code that can reach
// GitHub but not iconoplasm.brinedew.bio (Claude.ai's sandbox reaches only
// package registries and github.com) can still put blots into a figure.
//
// One run reads Iconoplasm's catalogue (one file from its CDN), works out each
// gene's current blot address with the site's own function, downloads the blots
// whose address changed since index.json, and commits them one first letter at
// a time, because GitHub refuses a push over 2 GB. Nothing here decides what a
// blot is: the site's drawer paints them, this copies what it painted.
//
//   node sync.mjs                    # copy every changed blot, commit, push
//   node sync.mjs --dry-run          # count the changes, write nothing
//   node sync.mjs --symbols KRAS,TP53 --no-push
//
// Runs hourly in .github/workflows/sync.yml. Needs git 2.34+ and Node 20+.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const CDN = "https://img.brinedew.bio"
const CATALOG_URL = `${CDN}/catalog/v3/index.json`
// The site's own blot identity (fingerprint and storage key). Loading it from
// the site's public repository keeps one definition: when the site redraws
// every blot under a new renderer revision, this copy follows.
const BLOT_MODULE_URL =
  "https://raw.githubusercontent.com/Brinedew/brinedew-site/main/workers/lib/iconoplasm-blot.js"
const USER_AGENT = "iconoplasm-blots-mirror (+https://github.com/Brinedew/iconoplasm-blots)"
const INDEX_PATH = "index.json"
const CONCURRENCY = 16
// GitHub's on-disk limit for a repository. Every changed blot adds its old
// version to history, so once one more full copy would cross the limit, the
// run replaces history with a single snapshot of the current files.
const GITHUB_REPOSITORY_LIMIT_BYTES = 10 * 1024 ** 3
// GitHub's own rule: 60 days without activity disables the schedule.
const KEEPALIVE_DAYS = 45

function parseArgs(argv) {
  const options = { dryRun: false, push: true, symbols: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--no-push") options.push = false
    else if (arg === "--symbols")
      options.symbols = new Set(
        String(argv[++index] || "")
          .split(",")
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean),
      )
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetries(url, { allow404 = false } = {}) {
  let lastError = null
  for (const delay of [0, 2000, 8000, 20000]) {
    if (delay) await sleep(delay)
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
      if (allow404 && response.status === 404) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`${url}: ${lastError?.message || lastError}`)
}

async function loadBlotModule() {
  const source = await (await fetchWithRetries(BLOT_MODULE_URL)).text()
  const file = path.join(os.tmpdir(), `iconoplasm-blot-${process.pid}.mjs`)
  writeFileSync(file, source)
  return import(pathToFileURL(file).href)
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()
}

function readIndex() {
  if (!existsSync(INDEX_PATH)) return { genes: {} }
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"))
  return index && typeof index.genes === "object" ? index : { genes: {} }
}

function writeIndex(index, blot) {
  const genes = Object.fromEntries(
    Object.entries(index.genes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const document = {
    schema: 1,
    source: "https://iconoplasm.brinedew.bio",
    license: "CC0-1.0",
    renderer: blot.ICONOPLASM_BLOT_RENDERER_REVISION,
    width: blot.ICONOPLASM_BLOT_WIDTH,
    height: blot.ICONOPLASM_BLOT_HEIGHT,
    path_pattern: "blot/{FIRST LETTER}/{SYMBOL}.webp",
    count: Object.keys(genes).length,
    genes,
  }
  // One gene per line keeps each sync's diff to the genes that changed.
  const lines = Object.entries(genes).map(
    ([symbol, entry]) => `    ${JSON.stringify(symbol)}: ${JSON.stringify(entry)}`,
  )
  const head = JSON.stringify({ ...document, genes: undefined }, null, 2).replace(/\n}$/, "")
  writeFileSync(INDEX_PATH, `${head},\n  "genes": {\n${lines.join(",\n")}\n  }\n}\n`)
}

// Every gene in the catalogue, with the address of its current blot.
function wantedBlots(catalog, blot, onlySymbols) {
  const wanted = new Map()
  let unaddressable = 0
  for (const row of catalog.genes) {
    const [symbol, name, portraitSha256] = row
    if (!portraitSha256) continue
    if (onlySymbols && !onlySymbols.has(String(symbol).toUpperCase())) continue
    const fingerprint = blot.iconoplasmBlotFingerprint({
      symbol,
      full_name: name,
      portrait: { status: "published", asset_sha256: portraitSha256 },
    })
    const key = blot.iconoplasmBlotObjectKey(symbol, fingerprint)
    if (!key) {
      unaddressable += 1
      continue
    }
    // A key exists only for a valid symbol, which the site keeps upper-case.
    const canonical = String(symbol).trim().toUpperCase()
    wanted.set(canonical, {
      symbol: canonical,
      name,
      fingerprint,
      url: `${CDN}/${key}`,
      path: `blot/${canonical[0]}/${canonical}.webp`,
    })
  }
  return { wanted, unaddressable }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await worker(items[index])
      }
    }),
  )
  return results
}

async function squashIfNearLimit(index) {
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository || !token) return
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  })
  if (!response.ok) return console.warn(`Repository size unreadable: HTTP ${response.status}`)
  const sizeBytes = (await response.json()).size * 1024
  const fullCopyBytes = Object.values(index.genes).reduce((sum, entry) => sum + (entry.bytes || 0), 0)
  console.log(
    `Repository ${(sizeBytes / 1024 ** 3).toFixed(2)} GB; one full copy ${(fullCopyBytes / 1024 ** 3).toFixed(2)} GB`,
  )
  if (sizeBytes + fullCopyBytes < GITHUB_REPOSITORY_LIMIT_BYTES) return
  // The server already holds every object of this tree, so the new root
  // commit is the only thing pushed.
  const snapshot = git(
    "commit-tree",
    "HEAD^{tree}",
    "-m",
    "Snapshot of the current blots (older versions dropped to stay under GitHub's 10 GB)",
  )
  git("push", "--force", "origin", `${snapshot}:refs/heads/main`)
  console.log(`History replaced by snapshot ${snapshot.slice(0, 12)}`)
}

// GitHub turns off a public repository's scheduled workflows after 60 days
// without activity, and a quiet catalogue commits nothing. An empty commit
// every 45 quiet days keeps the hourly sync running.
function keepScheduleAlive() {
  const lastCommitSeconds = Number(git("log", "-1", "--format=%ct"))
  if (Date.now() / 1000 - lastCommitSeconds < KEEPALIVE_DAYS * 86400) return
  git("commit", "--quiet", "--allow-empty", "-m", `No blot changed in ${KEEPALIVE_DAYS} days`)
  git("push", "--quiet", "origin", "HEAD:refs/heads/main")
  console.log("Pushed an empty commit so GitHub keeps the hourly schedule on")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const blot = await loadBlotModule()
  const catalog = await (await fetchWithRetries(CATALOG_URL)).json()
  if (catalog?.schema !== 3 || !Array.isArray(catalog.genes)) {
    throw new Error("catalog/v3/index.json is not schema 3")
  }
  const index = readIndex()
  const { wanted, unaddressable } = wantedBlots(catalog, blot, options.symbols)
  const changed = [...wanted.values()].filter(
    (entry) => index.genes[entry.symbol]?.fingerprint !== entry.fingerprint,
  )
  // A gene the catalogue no longer has (HGNC renamed or withdrew it) leaves.
  const removed = options.symbols
    ? []
    : Object.keys(index.genes).filter((symbol) => !wanted.has(symbol))
  console.log(
    `Catalogue ${catalog.genes.length} genes; mirror ${Object.keys(index.genes).length}; ` +
      `${changed.length} to copy, ${removed.length} to remove` +
      (unaddressable ? `, ${unaddressable} without a valid address` : ""),
  )
  if (options.dryRun) return

  const letters = [...new Set([...changed.map((e) => e.symbol[0]), ...removed.map((s) => s[0])])].sort()
  let copied = 0
  let notDrawnYet = 0
  const failures = []
  for (const letter of letters) {
    const batch = changed.filter((entry) => entry.symbol[0] === letter)
    const gone = removed.filter((symbol) => symbol[0] === letter)
    const added = []
    await mapLimit(batch, CONCURRENCY, async (entry) => {
      try {
        const response = await fetchWithRetries(entry.url, { allow404: true })
        // The drawer paints a new blot minutes after the catalogue names it;
        // the old file stays until the next run finds the new one.
        if (!response) return void (notDrawnYet += 1)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const size = blot.webpDimensions(bytes)
        if (size?.width !== blot.ICONOPLASM_BLOT_WIDTH || size?.height !== blot.ICONOPLASM_BLOT_HEIGHT) {
          throw new Error(`not a ${blot.ICONOPLASM_BLOT_WIDTH}x${blot.ICONOPLASM_BLOT_HEIGHT} WebP`)
        }
        mkdirSync(path.dirname(entry.path), { recursive: true })
        writeFileSync(entry.path, bytes)
        index.genes[entry.symbol] = {
          name: entry.name,
          path: entry.path,
          fingerprint: entry.fingerprint,
          bytes: bytes.length,
        }
        added.push(entry.path)
      } catch (error) {
        failures.push(`${entry.symbol}: ${error.message}`)
      }
    })
    for (const symbol of gone) {
      const file = index.genes[symbol]?.path
      delete index.genes[symbol]
      if (file) {
        git("rm", "--sparse", "--cached", "--quiet", "--ignore-unmatch", "--", file)
        rmSync(file, { force: true })
      }
    }
    if (!added.length && !gone.length) continue
    writeIndex(index, blot)
    // Blot folders sit outside the workflow's sparse checkout; --sparse adds
    // them anyway, and nothing else in the tree has to be downloaded.
    for (let at = 0; at < added.length; at += 500) {
      git("add", "--sparse", "--", ...added.slice(at, at + 500))
    }
    git("add", "--", INDEX_PATH)
    git(
      "commit",
      "--quiet",
      "-m",
      `${letter}: ${added.length} blot${added.length === 1 ? "" : "s"} copied` +
        (gone.length ? `, ${gone.length} removed` : ""),
    )
    if (options.push) git("push", "--quiet", "origin", "HEAD:refs/heads/main")
    copied += added.length
    console.log(`${letter}: ${added.length} copied, ${gone.length} removed`)
  }
  console.log(`Done: ${copied} copied, ${removed.length} removed, ${notDrawnYet} not drawn yet`)
  if (options.push) await squashIfNearLimit(index)
  if (options.push) keepScheduleAlive()
  if (failures.length) {
    console.error(`${failures.length} failed:\n${failures.slice(0, 50).join("\n")}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
