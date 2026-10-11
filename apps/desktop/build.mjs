// Bundle the main process (observer and server included) into one file and copy the built web UI next to it.
import { build } from 'esbuild'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const ui = `${here}../web/dist`
if (!existsSync(`${ui}/index.html`)) {
  console.error('apps/web/dist is missing: run `npm run build` at the repo root first')
  process.exit(1)
}
rmSync(`${here}dist`, { recursive: true, force: true })
rmSync(`${here}ui`, { recursive: true, force: true })
await build({
  entryPoints: [`${here}src/main.ts`],
  outfile: `${here}dist/main.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  legalComments: 'none',
  logLevel: 'warning',
})
cpSync(ui, `${here}ui`, { recursive: true, filter: (p) => !p.endsWith('.map') })
console.log('apps/desktop built')
