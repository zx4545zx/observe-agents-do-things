import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyPatch, DEFAULT_SETTINGS, loadSettings, normalizePath, saveSettings, toObserverOptions } from './settings.ts'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'oadt-set-')), 'settings.json')

test('defaults: 6 hours, every harness on with its own default path, notifications on', () => {
  assert.equal(DEFAULT_SETTINGS.backfillHours, 6)
  assert.deepEqual(toObserverOptions(DEFAULT_SETTINGS), { harnesses: ['pi', 'claude-code', 'codex'], sinceMs: 21_600_000, piDir: undefined, claudeDir: undefined, codexHome: undefined })
  assert.deepEqual(DEFAULT_SETTINGS.notifications, { enabled: true, attention: true, runCompleted: true })
})

test('settings survive a save and a load, and a missing file gives defaults without a warning', () => {
  const file = tmp()
  assert.deepEqual(loadSettings(file), { settings: DEFAULT_SETTINGS })
  const { settings } = applyPatch(DEFAULT_SETTINGS, { backfillHours: 72, harnesses: { pi: { enabled: false, path: '~/custom/pi' } }, notifications: { runCompleted: false } })
  saveSettings(file, settings)
  const back = loadSettings(file)
  assert.equal(back.warning, undefined)
  assert.equal(back.settings.backfillHours, 72)
  assert.equal(back.settings.harnesses.pi.enabled, false)
  assert.equal(back.settings.harnesses.pi.path, join(homedir(), 'custom/pi'))
  assert.equal(back.settings.notifications.runCompleted, false)
  assert.equal(back.settings.harnesses.codex.enabled, true, 'untouched values keep their default')
})

test('a damaged or invalid file resets to defaults and says so', () => {
  const file = tmp()
  writeFileSync(file, '{nope')
  assert.match(loadSettings(file).warning!, /could not be read/)
  writeFileSync(file, JSON.stringify({ backfillHours: -5 }))
  const r = loadSettings(file)
  assert.match(r.warning!, /invalid/)
  assert.equal(r.settings.backfillHours, 6)
})

test('validation rejects bad ranges, unknown harnesses, wrong types and relative paths, and changes nothing', () => {
  for (const patch of [
    { backfillHours: 0 }, { backfillHours: -1 }, { backfillHours: NaN }, { backfillHours: '24' }, { backfillHours: 24 * 365 },
    { harnesses: { cursor: { enabled: true } } },
    { harnesses: { pi: { enabled: 'yes' } } },
    { harnesses: { pi: { path: 'relative/dir' } } },
    { harnesses: { pi: { path: '/a\u0000b' } } },
    { notifications: { enabled: 1 } },
    'text', null, [],
  ]) {
    const r = applyPatch(DEFAULT_SETTINGS, patch)
    assert.ok(r.errors.length, JSON.stringify(patch))
    assert.equal(r.settings, DEFAULT_SETTINGS)
  }
})

test('paths: ~ expands, trailing slashes go, empty means the default', () => {
  assert.equal(normalizePath('~/x/'), join(homedir(), 'x'))
  assert.equal(normalizePath('  /Users/a/.pi/agent//  '), '/Users/a/.pi/agent')
  assert.equal(normalizePath(''), '')
})

test('custom paths and disabled harnesses map to observer options', () => {
  const { settings } = applyPatch(DEFAULT_SETTINGS, { backfillHours: 24, harnesses: { pi: { path: '/p' }, codex: { enabled: false, path: '/c' }, 'claude-code': { path: '/cl' } } })
  assert.deepEqual(toObserverOptions(settings), { harnesses: ['pi', 'claude-code'], sinceMs: 86_400_000, piDir: '/p', claudeDir: '/cl', codexHome: '/c' })
})

test('every preset converts to the right number of milliseconds', () => {
  const hours = { 6: 21_600_000, 24: 86_400_000, 72: 259_200_000, 168: 604_800_000 }
  for (const [h, ms] of Object.entries(hours)) assert.equal(toObserverOptions(applyPatch(DEFAULT_SETTINGS, { backfillHours: Number(h) }).settings).sinceMs, ms)
})
