import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bundledWheel, readWheelManifest } from '../lib/wheels.js'

async function collection(t) {
  const root = await mkdtemp(join(tmpdir(), 'hoploom-wheel-tags-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const platforms = [
    ['macos-x64', 'macosx_10_12_x86_64'], ['macos-arm64', 'macosx_11_0_arm64'],
    ['windows-x64', 'win_amd64'], ['windows-arm64', 'win_arm64'],
    ['glibc-x64', 'manylinux2014_x86_64.manylinux_2_17_x86_64'], ['glibc-arm64', 'manylinux_2_17_aarch64'],
    ['musl-x64', 'musllinux_1_2_x86_64'], ['musl-arm64', 'musllinux_1_2_aarch64'],
  ]
  const manifest = { schema: 2, version: '0.12.0', sourceCommit: 'a'.repeat(40), complete: true, wheels: [] }
  for (const [target, platform] of platforms) {
    const filename = `hoploom-0.12.0-cp310-abi3-${platform}.whl`
    const content = Buffer.from(target)
    manifest.wheels.push({ filename, target, python: 'cp310', abi: 'abi3', platforms: platform.split('.'),
      sha256: createHash('sha256').update(content).digest('hex') })
    await writeFile(join(root, filename), content)
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest }
}

test('actual interpreter tags select every architecture/libc independently of Node', async t => {
  const { root, manifest } = await collection(t)
  for (const wheel of manifest.wheels) {
    const selected = await bundledWheel([`cp313-cp313-${wheel.platforms[0]}`, `cp310-abi3-${wheel.platforms.at(-1)}`], root)
    assert.equal(selected.manifest.target, wheel.target)
    assert.equal((await readFile(selected.path)).toString(), wheel.target)
  }
  assert.equal((await bundledWheel(['cp310-abi3-win_arm64', 'cp310-abi3-win_amd64'], root)).manifest.target, 'windows-arm64')
  for (const tags of [[], ['cp310-abi3-musllinux_1_1_x86_64'], ['cp310-abi3-manylinux_2_17_armv7l'], ['cp314-abi3t-win_amd64'], ['pp310-pypy310_pp73-win_amd64']]) {
    await assert.rejects(bundledWheel(tags, root), { code: 'unsupported' })
  }
})

test('missing targets, disguised filenames and modified bytes fail integrity checks', async t => {
  const { root, manifest } = await collection(t)
  const original = JSON.stringify(manifest)
  manifest.wheels.pop()
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(readWheelManifest(root), { code: 'integrity' })
  const wrong = JSON.parse(original)
  wrong.wheels[0].filename = '../elsewhere.whl'
  await writeFile(join(root, 'manifest.json'), JSON.stringify(wrong))
  await assert.rejects(readWheelManifest(root), { code: 'integrity' })
  await writeFile(join(root, 'manifest.json'), original)
  const selected = manifest.wheels[0]
  await writeFile(join(root, selected.filename), 'modified wheel')
  await assert.rejects(bundledWheel([`cp310-abi3-${selected.platforms[0]}`], root), { code: 'integrity' })
})
