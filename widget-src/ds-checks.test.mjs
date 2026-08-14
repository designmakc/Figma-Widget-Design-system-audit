// Self-check for the pure helpers of the semantic-layer token rule.
// Bundles code.tsx as ESM (esbuild is already a devDep) over a minimal figma stub —
// the widget itself never runs, only its module-level helpers are imported.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import esbuild from 'esbuild'

const noop = () => undefined
globalThis.figma = {
  widget: {
    useSyncedState: () => [null, noop],
    useEffect: noop,
    register: noop,
    h: noop,
    AutoLayout: 'AutoLayout',
    Text: 'Text',
    SVG: 'SVG',
    Rectangle: 'Rectangle',
    Fragment: 'Fragment'
  }
}

const built = await esbuild.build({
  entryPoints: ['widget-src/code.tsx'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  write: false
})
const src = Buffer.from(built.outputFiles[0].text).toString('base64')
const {
  dsIsSemanticCollection, dsColorKey, dsCollectBindings,
  dsIsInSubComponentSection, dsSplitHiddenPrefix,
  DS_LAYOUT_NAMESPACE, DS_LAYOUT_ROOTLESS
} = await import('data:text/javascript;base64,' + src)

test('только semantic-коллекции проходят', () => {
  assert.equal(dsIsSemanticCollection('semantic'), true)
  assert.equal(dsIsSemanticCollection('semanticV2'), true)
  assert.equal(dsIsSemanticCollection('device'), false)
  assert.equal(dsIsSemanticCollection('primitive'), false)
  assert.equal(dsIsSemanticCollection('isloading'), false)
  assert.equal(dsIsSemanticCollection(''), false)
})

test('ключ цвета — 8-битная подпись RGBA', () => {
  assert.equal(dsColorKey({ r: 1, g: 0, b: 0 }), '255,0,0,255')
  assert.equal(dsColorKey({ r: 0, g: 0, b: 0, a: 0.5 }), '0,0,0,128')
})

test('словарь layout/ — второй сегмент источник изменчивости (rules 1.10.1)', () => {
  // живые имена, снятые с Base 2026-08-13
  for (const ok of [
    'layout/container/padding/horizontal',
    'layout/container/card/minWidth/perRow2',
    'layout/container/typography/h1/fontSize',
    'layout/page/padding/vertical',
    'layout/page/sidebar/width',
    'layout/card/gap/tight'
  ]) assert.equal(DS_LAYOUT_NAMESPACE.test(ok), true, ok)

  // дореформенные и бескорневые формы
  for (const bad of ['layout/section/padding/horizontal', 'layout/content/gap/vertical', 'layout/grid/gutter'])
    assert.equal(DS_LAYOUT_NAMESPACE.test(bad), false, bad)
  assert.equal(DS_LAYOUT_ROOTLESS.test('container/padding/horizontal'), true)
  assert.equal(DS_LAYOUT_ROOTLESS.test('system/container/full'), false)
})

test('субкомпонент опознаётся по секции, префикс публикации отделяется', () => {
  const section = (name) => ({ type: 'SECTION', name, parent: { type: 'PAGE', name: 'Modal', parent: null } })
  const set = (sectionName) => ({ type: 'COMPONENT_SET', name: 'x', parent: section(sectionName) })

  for (const n of ['SubComponent', '_SubComponent', 'Subcomponent', 'sub component'])
    assert.equal(dsIsInSubComponentSection(set(n)), true, n)
  assert.equal(dsIsInSubComponentSection(set('MasterComponent')), false)
  assert.equal(dsIsInSubComponentSection({ type: 'COMPONENT_SET', name: 'x', parent: null }), false)

  assert.deepEqual(dsSplitHiddenPrefix('_Processed'), { prefix: '_', body: 'Processed' })
  assert.deepEqual(dsSplitHiddenPrefix('modalHeader'), { prefix: '', body: 'modalHeader' })
})

test('собираются привязки всех форм boundVariables', () => {
  const alias = (id) => ({ type: 'VARIABLE_ALIAS', id })
  const found = dsCollectBindings({
    itemSpacing: alias('v1'),
    fills: [alias('v2'), { type: 'SOLID' }],
    strokes: [alias('v3')],
    componentProperties: { 'isLoading#1:0': alias('v4') },
    fontSize: alias('v5'),
    boundNothing: null
  })
  assert.deepEqual(found, [
    { field: 'itemSpacing', index: null, id: 'v1' },
    { field: 'fills', index: 0, id: 'v2' },
    { field: 'strokes', index: 0, id: 'v3' },
    { field: 'componentProperties.isLoading#1:0', index: null, id: 'v4' },
    { field: 'fontSize', index: null, id: 'v5' }
  ])
})
