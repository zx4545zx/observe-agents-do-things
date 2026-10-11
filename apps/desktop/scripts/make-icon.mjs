// Draws the app icon (no dependencies) and builds build/icon.png, build/icon.icns.
//   node scripts/make-icon.mjs      needs macOS `sips` and `iconutil` for the .icns
// Design: a dark rounded square, a lens ring, and three agents orbiting one observed centre.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../build/', import.meta.url))
const N = 1024
const SS = 3 // samples per axis for anti-aliasing
const px = new Uint8ClampedArray(N * N * 4)

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const hex = (h) => [h >> 16, (h >> 8) & 255, h & 255]
const sdRoundBox = (x, y, half, r) => { const qx = Math.abs(x) - half + r, qy = Math.abs(y) - half + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r }

const TOP = hex(0x1d2740), BOTTOM = hex(0x090d16)
const CYAN = hex(0x3de0d4), BLUE = hex(0x4b8dff), GREEN = hex(0x5be38a), AMBER = hex(0xffc24a)
const sats = [[-90, CYAN], [30, GREEN], [150, AMBER]].map(([deg, c]) => ({ x: Math.cos((deg * Math.PI) / 180) * 0.27, y: Math.sin((deg * Math.PI) / 180) * 0.27, c }))

/** Colour and coverage at a point in [-0.5, 0.5]². */
function sample(x, y) {
  const body = -sdRoundBox(x, y, 0.4, 0.18)
  if (body < 0) return [0, 0, 0, 0]
  let c = mix(TOP, BOTTOM, y + 0.5)
  const d = Math.hypot(x, y)
  const glow = Math.max(0, 1 - d / 0.42) ** 2
  c = mix(c, [40, 70, 120], glow * 0.5)
  const ring = 1 - Math.min(1, Math.abs(d - 0.27) / 0.022)
  if (ring > 0) c = mix(c, mix(BLUE, CYAN, 0.5 + x), ring)
  const lens = 1 - Math.min(1, Math.abs(d - 0.34) / 0.008)
  if (lens > 0) c = mix(c, [120, 160, 220], lens * 0.35)
  const pupil = d < 0.1 ? 1 : 0
  if (pupil) c = mix([235, 250, 255], CYAN, Math.min(1, d / 0.1) ** 2)
  for (const s of sats) {
    const sd = Math.hypot(x - s.x, y - s.y)
    if (sd < 0.058) c = mix(s.c, [255, 255, 255], sd < 0.02 ? 0.5 : 0)
    else if (sd < 0.075) c = mix(c, s.c, 0.25)
  }
  return [c[0], c[1], c[2], 255]
}

for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  let r = 0, g = 0, b = 0, a = 0
  for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
    const s = sample((i + (si + 0.5) / SS) / N - 0.5, (j + (sj + 0.5) / SS) / N - 0.5)
    r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3]
  }
  const o = (j * N + i) * 4, n = SS * SS
  if (a > 0) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = a / n }
}

function png(w, h, rgba) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]) }
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync(out, { recursive: true })
writeFileSync(`${out}icon.png`, png(N, N, px))
const set = `${out}icon.iconset`
rmSync(set, { recursive: true, force: true })
mkdirSync(set)
for (const s of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const name = `icon_${s}x${s}${scale === 2 ? '@2x' : ''}.png`
  execFileSync('sips', ['-z', String(s * scale), String(s * scale), `${out}icon.png`, '--out', `${set}/${name}`], { stdio: 'ignore' })
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', `${out}icon.icns`])
rmSync(set, { recursive: true })
console.log('wrote build/icon.png and build/icon.icns')
