#!/usr/bin/env node

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const WARN_MIB = 30
const HARD_LIMIT_MIB = 40
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requiredFiles = [
  join(root, 'dist/server/index.js'),
  join(root, 'dist/.openai/hosting.json'),
]

for (const path of requiredFiles) {
  try {
    statSync(path)
  } catch {
    console.error(`Missing required Sites artifact file: ${path}`)
    process.exit(2)
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'sites-artifact-check-'))
const archive = join(temporary, 'site.tar.gz')

try {
  const packaged = spawnSync('tar', ['-C', root, '-czf', archive, 'dist'], {
    encoding: 'utf8',
  })
  if (packaged.status !== 0) {
    process.stderr.write(packaged.stderr || 'Unable to package Sites artifact.\n')
    process.exit(packaged.status || 2)
  }

  const bytes = statSync(archive).size
  const sizeMib = bytes / 1048576
  const result = {
    bytes,
    mib: Number(sizeMib.toFixed(2)),
    warningMib: WARN_MIB,
    hardLimitMib: HARD_LIMIT_MIB,
    status: sizeMib > HARD_LIMIT_MIB ? 'fail' : sizeMib > WARN_MIB ? 'warning' : 'ok',
  }
  console.log(JSON.stringify(result))

  if (sizeMib > HARD_LIMIT_MIB) {
    console.error(`Sites archive exceeds the ${HARD_LIMIT_MIB} MiB hard limit; do not upload it.`)
    process.exit(1)
  }
  if (sizeMib > WARN_MIB) {
    console.warn(`Sites archive exceeds the ${WARN_MIB} MiB warning threshold.`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
