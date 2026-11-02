import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { SetupError } from './state.js'

const MAX_BINARY = 100 * 1024 * 1024

/** Extract only a named regular-file member into memory, never archive paths. */
export function extractUv(archive: Buffer, filename: string): Buffer {
  if (filename.endsWith('.zip')) {
    const files = unzipSync(archive, { filter: entry => {
      if (entry.name !== 'uv.exe') return false
      if (entry.originalSize > MAX_BINARY) throw new SetupError('integrity')
      return true
    } })
    if (!files['uv.exe']?.length) throw new SetupError('integrity')
    return Buffer.from(files['uv.exe'])
  }
  const tar = gunzipSync(archive, { maxOutputLength: 2 * MAX_BINARY })
  const member = filename.replace(/\.tar\.gz$/, '') + '/uv'
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
    const rawSize = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim()
    if (!name) break
    if (!/^[0-7]+$/.test(rawSize)) throw new SetupError('integrity')
    const size = Number.parseInt(rawSize, 8)
    if (size > MAX_BINARY || offset + 512 + size > tar.length) throw new SetupError('integrity')
    if (name === member && (header[156] === 0 || header[156] === 48)) {
      return Buffer.from(tar.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new SetupError('integrity')
}
