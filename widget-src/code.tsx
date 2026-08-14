const { widget } = figma
const { useSyncedState, useEffect, AutoLayout, Text, SVG, Rectangle } = widget

// Helper function to ensure safe text rendering - never returns empty strings
const safeText = (value: any): string => {
  // Handle null, undefined, false, 0, etc.
  if (value === null || value === undefined || value === false) return 'N/A'
  
  // Handle arrays and objects
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `Array(${value.length})`
    return 'Object'
  }
  
  // Convert to string and clean
  const str = String(value).trim()
  
  // Return N/A for any empty or whitespace-only strings
  return str.length > 0 ? str : 'N/A'
}

interface UnboundProperty {
  type: 'fill' | 'stroke' | 'text' | 'cornerRadius' | 'spacing' | 'effect' | 'appearance' | 'tokenMisuse'
  property: string
  currentValue?: string
  nodePath?: string
  nodeId?: string  // Store the actual node ID for direct navigation
  ruleId?: string  // DS rule id for tokenMisuse findings (per-rule settings filter)
  fixRename?: string  // auto-fix: rename target node to this value
  fixBindVariableId?: string  // auto-fix: bind this variable...
  fixBindName?: string        // ...(display name)...
  fixBindField?: string       // ...to this bindable node field
}

interface ComponentAuditData {
  id: string
  name: string
  componentSetName?: string
  variantProperties?: Record<string, string>
  pageName: string
  hasDescription: boolean
  hasDocumentationLink: boolean
  hasUnboundProperties: boolean
  unboundProperties: UnboundProperty[]
  isHiddenFromPublishing: boolean
  isOnCurrentPage: boolean
  isComponentSet?: boolean  // True if this represents the component set itself
  isVariant?: boolean       // True if this is a variant within a component set
  hasExpandableContent?: boolean  // True if component set has variants with unbound properties, or individual component has unbound properties
  usedComponents?: string[] // Library/local components instantiated inside (what devs import)
}

interface PageProgress {
  name: string
  status: 'pending' | 'loading' | 'complete' | 'error'
  componentCount: number
}

interface PageData {
  pageName: string
  components: ComponentAuditData[]
  isExpanded: boolean
  displayedCount: number
}

// ============================================================================
// DS token semantic-fit checks (Genlab DS rules v1.3.0, docs/rules/tokens/*)
// Beyond "bound or not": verifies a bound variable is the RIGHT token for the
// property it is bound to. Rule ids reference docs/rules in the DS repo.
// ============================================================================

interface ResolvedVar {
  id: string          // variable id — needed to resolve its value for a replacement lookup
  name: string        // variable name, e.g. "layout/container/padding/vertical"
  collection: string  // collection name, e.g. "semantic" / "device" / "primitive"
  resolvedType: string // 'FLOAT' | 'COLOR' | 'BOOLEAN' | 'STRING'
}

// Only the semantic layer is bindable from components: primitive is the raw
// scale, device/isloading are hidden engines. Tolerates "semanticV2"-style names.
export const dsIsSemanticCollection = (collection: string): boolean =>
  (collection || '').toLowerCase().indexOf('semantic') === 0

// Variable ids repeat heavily across components — resolve each id once per session.
const dsVarCache = new Map<string, ResolvedVar | null>()

const resolveBoundVar = async (id: string): Promise<ResolvedVar | null> => {
  if (dsVarCache.has(id)) return dsVarCache.get(id) || null
  let resolved: ResolvedVar | null = null
  try {
    const v = await figma.variables.getVariableByIdAsync(id)
    if (v) {
      let collection = ''
      try {
        const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId)
        if (c) collection = c.name
      } catch (e) {
        // Remote (library) collections may not resolve — variable name alone still usable
      }
      resolved = { id, name: v.name, collection, resolvedType: String(v.resolvedType || '') }
    }
  } catch (e) {
    // Unresolvable id — treat as unknown, never crash the scan
  }
  dsVarCache.set(id, resolved)
  return resolved
}

// Component-slug registry for tokens-no-component-tier (DEC-014): a token middle
// segment must not repeat a component name. Built from component sets in scanned pages.
let dsComponentSlugs = new Set<string>()

const buildSlugRegistry = (pages: PageNode[]) => {
  dsComponentSlugs = new Set<string>()
  pages.forEach(page => {
    const sets = page.findAll(n => n.type === 'COMPONENT_SET')
    sets.forEach(set => {
      const slug = (set.name || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      if (slug) dsComponentSlugs.add(slug)
    })
  })
}

// ---------------------------------------------------------------------------
// Token suggestions: value → semantic-token maps, built once per scan.
// Enables "Привязать" auto-fix on unbound findings and semantic replacements
// on findings bound to a non-semantic token.
// ---------------------------------------------------------------------------

interface DsFloatToken { value: number; id: string; name: string; collection: string }
interface DsColorToken { key: string; id: string; name: string }
let dsFloatTokens: DsFloatToken[] = []
let dsColorTokens: DsColorToken[] = []

const dsResolveFloatValue = async (varObj: any, depth: number): Promise<number | null> => {
  if (!varObj || depth > 4) return null
  let col: any = null
  try {
    col = await figma.variables.getVariableCollectionByIdAsync(varObj.variableCollectionId)
  } catch (e) { /* remote collection */ }
  if (!col) return null
  const modeId = col.defaultModeId || (col.modes && col.modes[0] && col.modes[0].modeId)
  const raw = varObj.valuesByMode ? varObj.valuesByMode[modeId] : undefined
  if (typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && (raw as any).type === 'VARIABLE_ALIAS') {
    try {
      const next = await figma.variables.getVariableByIdAsync((raw as any).id)
      return dsResolveFloatValue(next, depth + 1)
    } catch (e) { return null }
  }
  return null
}

const dsResolveColorValue = async (varObj: any, depth: number): Promise<any> => {
  if (!varObj || depth > 4) return null
  let col: any = null
  try {
    col = await figma.variables.getVariableCollectionByIdAsync(varObj.variableCollectionId)
  } catch (e) { /* remote collection */ }
  if (!col) return null
  const modeId = col.defaultModeId || (col.modes && col.modes[0] && col.modes[0].modeId)
  const raw = varObj.valuesByMode ? varObj.valuesByMode[modeId] : undefined
  if (raw && typeof raw === 'object' && (raw as any).type === 'VARIABLE_ALIAS') {
    try {
      const next = await figma.variables.getVariableByIdAsync((raw as any).id)
      return dsResolveColorValue(next, depth + 1)
    } catch (e) { return null }
  }
  if (raw && typeof raw === 'object' && typeof (raw as any).r === 'number') return raw
  return null
}

// 8-bit signature of an RGBA colour — the lookup key of the colour-token map
export const dsColorKey = (c: any): string =>
  [c.r, c.g, c.b, c.a === undefined ? 1 : c.a].map((n: number) => Math.round(n * 255)).join(',')

// ponytail: values are read in the collection's default mode only — a multi-brand
// exact match would need per-mode diffing and gives no better suggestion.
const buildTokenMaps = async () => {
  dsFloatTokens = []
  dsColorTokens = []
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    const colById: Record<string, any> = {}
    collections.forEach(c => { colById[c.id] = c })

    const floats = await figma.variables.getLocalVariablesAsync('FLOAT')
    for (const v of floats) {
      const col = colById[v.variableCollectionId]
      if (!col || !dsIsSemanticCollection(col.name)) continue
      const value = await dsResolveFloatValue(v, 0)
      if (value !== null) {
        dsFloatTokens.push({ value, id: v.id, name: v.name, collection: col.name })
      }
    }

    const colors = await figma.variables.getLocalVariablesAsync('COLOR')
    for (const v of colors) {
      const col = colById[v.variableCollectionId]
      if (!col || !dsIsSemanticCollection(col.name)) continue
      const rgba = await dsResolveColorValue(v, 0)
      if (rgba) dsColorTokens.push({ key: dsColorKey(rgba), id: v.id, name: v.name })
    }
  } catch (e) {
    console.error('Error building token maps:', e)
  }
}

// Category regex must agree with spacing-category-property-match — never
// suggest a token our own rules would then flag
const DS_SUGGEST_CATEGORY: Record<string, RegExp> = {
  gap: /(^|\/)gap\//,
  padding: /(^|\/)padding\//,
  radius: /^radius\//,
  borderWidth: /^borderWidth\//
}

const dsSuggestToken = (value: number, category: string): DsFloatToken | null => {
  const rx = DS_SUGGEST_CATEGORY[category]
  if (!rx || dsFloatTokens.length === 0) return null
  const candidates = dsFloatTokens.filter(t => Math.abs(t.value - value) < 0.01 && rx.test(t.name))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.name.length - b.name.length)
  return candidates[0]
}

const dsSuggestColorToken = (key: string): DsColorToken | null => {
  const candidates = dsColorTokens.filter(t => t.key === key)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.name.length - b.name.length)
  return candidates[0]
}

// Bindable node field → token category, so a replacement never violates
// spacing-category-property-match
const DS_FIELD_CATEGORY: Record<string, string> = {
  itemSpacing: 'gap', counterAxisSpacing: 'gap', gap: 'gap',
  paddingTop: 'padding', paddingRight: 'padding', paddingBottom: 'padding', paddingLeft: 'padding',
  cornerRadius: 'radius', topLeftRadius: 'radius', topRightRadius: 'radius',
  bottomLeftRadius: 'radius', bottomRightRadius: 'radius',
  strokeWeight: 'borderWidth', strokeTopWeight: 'borderWidth', strokeRightWeight: 'borderWidth',
  strokeBottomWeight: 'borderWidth', strokeLeftWeight: 'borderWidth'
}
const DS_PAINT_FIELDS = ['fills', 'strokes']

interface DsFix { fixBindVariableId: string; fixBindName: string; fixBindField: string }

// Which semantic token carries the same value as the wrongly bound one
const dsSuggestSemanticFix = async (v: ResolvedVar, field: string, index: number | null): Promise<DsFix | null> => {
  try {
    const varObj = await figma.variables.getVariableByIdAsync(v.id)
    if (!varObj) return null

    if (v.resolvedType === 'COLOR') {
      if (DS_PAINT_FIELDS.indexOf(field) === -1) return null
      const rgba = await dsResolveColorValue(varObj, 0)
      if (!rgba) return null
      const hit = dsSuggestColorToken(dsColorKey(rgba))
      if (!hit) return null
      return {
        fixBindVariableId: hit.id,
        fixBindName: hit.name,
        fixBindField: index === null ? field : `${field}[${index}]`
      }
    }

    if (v.resolvedType === 'FLOAT') {
      const category = DS_FIELD_CATEGORY[field]
      if (!category) return null
      const value = await dsResolveFloatValue(varObj, 0)
      if (value === null) return null
      const hit = dsSuggestToken(value, category)
      if (!hit) return null
      return { fixBindVariableId: hit.id, fixBindName: hit.name, fixBindField: field }
    }
  } catch (e) {
    // Suggestion is best-effort — a finding without a fix is still a finding
  }
  return null
}

// Every bound variable of a node, whatever the field: arrays (fills/strokes/effects),
// plain aliases (spacing, radii) and maps (componentProperties). Explicit lists would
// silently miss text, effect and size bindings.
export const dsCollectBindings = (bv: any): { field: string; index: number | null; id: string }[] => {
  const out: { field: string; index: number | null; id: string }[] = []
  const push = (field: string, index: number | null, a: any) => {
    if (a && a.type === 'VARIABLE_ALIAS' && a.id) out.push({ field, index, id: a.id })
  }
  for (const key of Object.keys(bv || {})) {
    const val = bv[key]
    if (!val || typeof val !== 'object') continue
    if (Array.isArray(val)) {
      val.forEach((a: any, i: number) => push(key, i, a))
    } else if (val.type === 'VARIABLE_ALIAS') {
      push(key, null, val)
    } else {
      for (const sub of Object.keys(val)) {
        const inner = val[sub]
        if (Array.isArray(inner)) inner.forEach((a: any, i: number) => push(`${key}.${sub}`, i, a))
        else push(`${key}.${sub}`, null, inner)
      }
    }
  }
  return out
}

const DS_GAP_PROPS = ['itemSpacing', 'counterAxisSpacing', 'gap']
const DS_PADDING_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
const DS_SPACING_PROP_LABELS: Record<string, string> = {
  itemSpacing: 'Item Spacing',
  counterAxisSpacing: 'Counter Axis Spacing',
  gap: 'Gap',
  paddingTop: 'Padding Top',
  paddingRight: 'Padding Right',
  paddingBottom: 'Padding Bottom',
  paddingLeft: 'Padding Left'
}
const DS_FIELD_LABELS: Record<string, string> = {
  fills: 'Fill',
  strokes: 'Stroke Color',
  strokeWeight: 'Stroke Weight',
  cornerRadius: 'Corner Radius',
  effects: 'Effect',
  opacity: 'Opacity'
}
// token-name-variability-namespace (rules v1.10.1, tokens v4.0.0): раскладочные
// токены живут под общим корнем layout/, ВТОРОЙ сегмент отвечает «от чего зависит
// значение»: container — тир, page — девайс, card — константа. Дальше свободное имя
// свойства или объекта, поэтому проверяется схема, а не перечень листьев.
export const DS_LAYOUT_NAMESPACE = /^layout\/(container|page|card)\/[a-zA-Z0-9]/
// Дореформенные ветки словаря 1.3.0 → чем заменены (удалены из Base 2026-08-08/12)
const DS_LAYOUT_LEGACY: { rx: RegExp; hint: string }[] = [
  { rx: /^layout\/(page|container)\/margin\//, hint: 'margin в layout/ больше нет — рамка страницы это layout/page/padding/*' },
  { rx: /^layout\/section\//, hint: 'ветка section/ снята — это layout/container/*' },
  { rx: /^layout\/content\//, hint: 'ветка content/ снята — межблочный интервал это layout/container/gap/*' }
]
// Раскладочный токен, оставшийся без корня layout/ (схема 1.10.0, прожила один день)
export const DS_LAYOUT_ROOTLESS = /^(container|page|section)\/(padding|gap|grid|margin|size|card|typography)\//
// Служебные коллекции плагина uSpec — не токены продукта, из правил исключены
const DS_TOOLING_COLLECTIONS = /^specs( layout)?$/

// ruleId → settings key: per-rule visibility toggles in the settings panel
const DS_RULE_SETTINGS: Record<string, string> = {
  'spacing-category-property-match': 'showRuleSpacingCategory',
  'spacing-layout-vocabulary': 'showRuleLayoutVocab',
  'spacing-region-scope': 'showRuleRegionScope',
  'spacing-bind-semantic-layer': 'showRuleSemanticLayer',
  'tier-discipline': 'showRuleTierDiscipline',
  'tokens-no-component-tier': 'showRuleComponentTier',
  'gradient-stop-unbound': 'showRuleGradientStops',
  'component-name-pascalcase': 'showRuleComponentName',
  'subcomponent-name-lowercase': 'showRuleSubComponentName',
  'component-property-camelcase': 'showRulePropCamelCase',
  'boolean-prefix-convention': 'showRuleBooleanPrefix',
  'component-property-tier1-glossary': 'showRuleGlossary',
  'state-axis-canonical-enum': 'showRuleGlossary',
  'layer-naming-camelcase': 'showRuleLayerNaming'
}

const checkTokenMisuse = async (root: ComponentNode): Promise<UnboundProperty[]> => {
  const findings: UnboundProperty[] = []

  const report = (node: SceneNode, path: string, property: string, ruleId: string, message: string, fix?: DsFix | null) => {
    const finding: UnboundProperty = {
      type: 'tokenMisuse',
      property,
      currentValue: safeText(message),
      nodePath: safeText(path),
      nodeId: node.id,
      ruleId
    }
    if (fix) {
      finding.fixBindVariableId = fix.fixBindVariableId
      finding.fixBindName = fix.fixBindName
      finding.fixBindField = fix.fixBindField
    }
    findings.push(finding)
  }

  // Checks that apply to ANY bound variable regardless of the property
  const checkUniversal = async (node: SceneNode, path: string, field: string, propLabel: string, index: number | null, v: ResolvedVar) => {
    const collection = (v.collection || '').toLowerCase()

    // BOOLEAN variables are switch engines (`system/visible/*`, `isloading/skeleton/*`),
    // not style tokens — by design they live outside the semantic layer. Same for
    // componentProperties: the DS drives variant tiers by a mode→property bridge.
    // `Specs`/`Specs Layout` are the uSpec plugin's own collections, not product tokens.
    if (v.resolvedType === 'BOOLEAN' || field.indexOf('componentProperties.') === 0 ||
        DS_TOOLING_COLLECTIONS.test(collection) ||
        /(^|\/)visible\//.test(v.name) || v.name === 'system/device' || v.name === 'device') return

    // Bind the semantic layer, nothing else: primitive is the raw scale,
    // device and any other collection are hidden engines.
    const isPrimitive = collection.indexOf('primitive') === 0 || v.name.startsWith('primitive/')
    if (isPrimitive || (collection && !dsIsSemanticCollection(collection))) {
      const ruleId = isPrimitive ? 'tier-discipline' : 'spacing-bind-semantic-layer'
      const head = isPrimitive
        ? `«${v.name}» — primitive-токен, биндить semantic-уровень`
        : `«${v.name}» привязан из коллекции «${v.collection}» — биндить semantic-слой`
      const fix = await dsSuggestSemanticFix(v, field, index)
      report(node, path, propLabel, ruleId, `${head} (${ruleId})`, fix)
    }

    // DEC-024 (tokens-no-disabled-suffix-leaf) RETIRED 2026-07-23: disabled-токены
    // цвета легальны наравне с opacity/disabled overlay — проверка снята.

    // tokens-no-component-tier (DEC-014, soft): middle segment must not repeat a component slug
    const segments = v.name.split('/')
    const middles = segments.slice(1, -1)
    const hit = middles.find(seg => dsComponentSlugs.has(seg.toLowerCase()))
    if (hit) {
      report(node, path, propLabel, 'tokens-no-component-tier', `«${v.name}» — сегмент «${hit}» совпадает с именем компонента; токены должны быть role/category-tier (tokens-no-component-tier, DEC-014)`)
    }
  }

  const walk = async (node: SceneNode, parentPath: string): Promise<void> => {
    const safeName = safeText(node.name) !== 'N/A' ? safeText(node.name) : (node.type || 'Node')
    const path = parentPath ? `${parentPath} > ${safeName}` : safeName
    const bv: any = (node as any).boundVariables

    if (bv) {
      // --- Spacing props: category and region rules ---
      // Grid layout: itemSpacing/gap are stale flow-layout leftovers — skip them
      const isGridLayout = (node as any).layoutMode === 'GRID'
      for (const key of [...DS_GAP_PROPS, ...DS_PADDING_PROPS]) {
        if (isGridLayout && DS_GAP_PROPS.indexOf(key) !== -1) continue
        const alias = bv[key]
        if (alias && alias.type === 'VARIABLE_ALIAS') {
          const v = await resolveBoundVar(alias.id)
          if (!v) continue
          const label = DS_SPACING_PROP_LABELS[key] || key

          const isGapProp = DS_GAP_PROPS.indexOf(key) !== -1

          // spacing-category-property-match (hard): token category must match property category
          if (isGapProp && /(^|\/)(padding|margin)\//.test(v.name)) {
            report(node, path, label, 'spacing-category-property-match', `привязан «${v.name}» — на gap-свойства только */gap/* токены (spacing-category-property-match)`)
          }
          if (!isGapProp && /(^|\/)gap\//.test(v.name)) {
            report(node, path, label, 'spacing-category-property-match', `привязан «${v.name}» — на padding-свойства только */padding/* или */margin/* токены (spacing-category-property-match)`)
          }

          // token-name-variability-namespace (hard): проверяется только на semantic —
          // внутри device/container те же токены живут с укороченными именами by design
          // (`layout/page/*`, `layout/gap/*`), это фасадные ветки, а не нарушение схемы
          if (dsIsSemanticCollection(v.collection)) {
            const legacy = DS_LAYOUT_LEGACY.filter(l => l.rx.test(v.name))[0]
            if (legacy) {
              report(node, path, label, 'spacing-layout-vocabulary', `привязан «${v.name}» — дореформенное имя: ${legacy.hint} (token-name-variability-namespace)`)
            } else if (v.name.startsWith('layout/') && !DS_LAYOUT_NAMESPACE.test(v.name)) {
              report(node, path, label, 'spacing-layout-vocabulary', `привязан «${v.name}» — второй сегмент обязан быть источником изменчивости: layout/{container|page|card}/… (token-name-variability-namespace)`)
            } else if (DS_LAYOUT_ROOTLESS.test(v.name)) {
              report(node, path, label, 'spacing-layout-vocabulary', `привязан «${v.name}» — раскладочный токен вне корня layout/ (token-name-variability-namespace)`)
            }
          }

          // spacing-region-scope: layout/page/* зависит от девайса и применяется на
          // page-шаблоне; внутри компонента легален только для позиционирования
          // полноэкранного оверлея от вьюпорта — любое другое применение на ревью
          if (v.name.startsWith('layout/page/')) {
            report(node, path, label, 'spacing-region-scope', `привязан «${v.name}» — page-токен внутри компонента; легален только для позиционирования полноэкранного оверлея от вьюпорта, проверить (spacing-region-scope)`)
          }
        }
      }

      // --- Every binding on the node: must come from the semantic layer ---
      for (const b of dsCollectBindings(bv)) {
        if (isGridLayout && DS_GAP_PROPS.indexOf(b.field) !== -1) continue
        const v = await resolveBoundVar(b.id)
        if (!v) continue
        const label = DS_FIELD_LABELS[b.field] || DS_SPACING_PROP_LABELS[b.field] || b.field
        await checkUniversal(node, path, b.field, label, b.index, v)
      }
    }

    // --- Gradient stops (DEC-036): every stop color must be bound to a color/gradient/* variable ---
    for (const paintKey of ['fills', 'strokes']) {
      if (paintKey in node) {
        const paints = (node as any)[paintKey]
        if (paints && paints !== figma.mixed && Array.isArray(paints)) {
          paints.forEach((paint: any, pi: number) => {
            if (paint.visible === false) return
            if (typeof paint.type === 'string' && paint.type.indexOf('GRADIENT_') === 0) {
              const stops = paint.gradientStops || []
              stops.forEach((stop: any, si: number) => {
                const bound = stop.boundVariables && stop.boundVariables.color &&
                              stop.boundVariables.color.type === 'VARIABLE_ALIAS'
                if (!bound) {
                  report(node, path, `Gradient ${pi + 1} stop ${si + 1}`, 'gradient-stop-unbound', `цвет стопа не привязан к переменной color/gradient/* (gradient-stop-unbound, DEC-036)`)
                }
              })
            }
          })
        }
      }
    }

    if ('children' in node && node.children) {
      for (const child of node.children) {
        await walk(child, path)
      }
    }
  }

  try {
    await walk(root, '')
  } catch (e) {
    console.error('Error in checkTokenMisuse:', e)
  }
  return findings
}

// ============================================================================
// DS naming checks (A-block): component/property/layer naming conventions
// docs/rules/components/*.md — DEC-032, DEC-007, DEC-031, DEC-025/030, DEC-008
// ============================================================================

const DS_PASCAL = /^[A-Z][a-zA-Z0-9]*$/
const DS_CAMEL = /^[a-z][a-zA-Z0-9]*$/

// "Progress bar" → "progressBar"; ALL-CAPS words are lowercased first
const dsNormWord = (w: string): string => (w.length > 1 && w === w.toUpperCase() ? w.toLowerCase() : w)
const dsToCamelCase = (s: string): string => {
  const words = s.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean).map(dsNormWord)
  if (words.length === 0) return s
  return words.map((w, i) => i === 0
    ? w.charAt(0).toLowerCase() + w.slice(1)
    : w.charAt(0).toUpperCase() + w.slice(1)).join('')
}
const dsToPascalCase = (s: string): string => {
  const words = s.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean).map(dsNormWord)
  if (words.length === 0) return s
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}
// Tier-1 glossary anti-names → canonical axis name (DEC-025).
// 'position' intentionally absent: legit Tier-2 axis (e.g. corneroverlay).
const DS_GLOSSARY_ANTINAMES: Record<string, string> = {
  style: 'variant',
  buttonSize: 'size',
  level: 'priority',
  weight: 'priority',
  status: 'state',
  mode: 'state',
  side: 'labelPosition'
}
const DS_STATE_ENUM = ['default', 'hover', 'focus', 'empty', 'filled', 'loading', 'success', 'error', 'disabled']
const DS_VARIANT_ENUM = ['solid', 'outline', 'ghost', 'unstyled']
const DS_LABELPOS_ENUM = ['left', 'right']
// glossary v2, ось priority — семантическая роль, binding к color/action/{priority}/*
const DS_PRIORITY_ENUM = ['neutral', '1', '2', '3', '4', 'inverse']
// `size` намеренно не проверяется: enum расширяемый (lg|md|sm, DEC-025)

// Section holding a component's private parts. Live spellings in `Base`:
// "SubComponent", "_SubComponent", "Subcomponent" (19 sections, 2026-08-13).
const DS_SUBCOMPONENT_SECTION = /^[._]?sub[\s_-]?components?$/i

// Walks up to the page: is this component parked in a subComponent section?
export const dsIsInSubComponentSection = (node: BaseNode | null): boolean => {
  let cur: BaseNode | null = node && node.parent
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if (cur.type === 'SECTION' && DS_SUBCOMPONENT_SECTION.test((cur.name || '').trim())) return true
    cur = cur.parent
  }
  return false
}

// Publishing prefixes ('.', '_') sit before the name proper and are not casing
export const dsSplitHiddenPrefix = (name: string): { prefix: string; body: string } => {
  const m = /^([._]+)?([\s\S]*)$/.exec(name.trim())
  return { prefix: (m && m[1]) || '', body: (m && m[2]) || '' }
}

const dsNamingFinding = (node: BaseNode, property: string, ruleId: string, message: string): UnboundProperty => ({
  type: 'tokenMisuse',
  property,
  currentValue: safeText(message),
  nodePath: safeText(node.name),
  nodeId: node.id,
  ruleId
})

// Component-set-level checks: set name casing + property definitions.
// Works for ComponentSetNode and standalone ComponentNode (not a variant).
const checkComponentNaming = (root: ComponentSetNode | ComponentNode): UnboundProperty[] => {
  const findings: UnboundProperty[] = []
  const name = (root.name || '').trim()
  const { prefix, body } = dsSplitHiddenPrefix(name)

  if (dsIsInSubComponentSection(root)) {
    // subcomponent-name-lowercase: части компонента живут в секции subComponent
    // и именуются со строчной буквы — так они отличаются от публичных компонентов.
    // PascalCase-правило здесь не применяется: требования взаимоисключающие.
    if (body && !/^[a-z]/.test(body)) {
      const finding = dsNamingFinding(root, 'Имя субкомпонента', 'subcomponent-name-lowercase',
        `«${name}» лежит в секции subComponent — имя должно начинаться со строчной буквы (subcomponent-name-lowercase)`)
      finding.fixRename = prefix + dsToCamelCase(body)
      findings.push(finding)
    }
  } else if (name && !DS_PASCAL.test(name)) {
    // component-name-pascalcase (DEC-032, hard)
    const finding = dsNamingFinding(root, 'Имя компонента', 'component-name-pascalcase',
      `«${name}» — имя компонента должно быть PascalCase слитно, без пробелов/дефисов/подчёркиваний (component-name-pascalcase, DEC-032)`)
    finding.fixRename = dsToPascalCase(name)
    findings.push(finding)
  }

  let defs: any = null
  try {
    defs = root.componentPropertyDefinitions
  } catch (e) {
    defs = null // variant components throw — definitions live on the set
  }
  if (!defs) return findings

  for (const rawKey of Object.keys(defs)) {
    const def = defs[rawKey]
    const propName = rawKey.split('#')[0].trim()
    if (!propName) continue

    const isBooleanLike = def.type === 'BOOLEAN' ||
      (def.type === 'VARIANT' && Array.isArray(def.variantOptions) &&
       def.variantOptions.length === 2 &&
       def.variantOptions.every((o: string) => o === 'true' || o === 'false'))

    // component-property-camelcase (DEC-007, hard)
    if (!DS_CAMEL.test(propName)) {
      findings.push(dsNamingFinding(root, `Свойство ${propName}`, 'component-property-camelcase',
        `«${propName}» — имя свойства должно быть camelCase (component-property-camelcase, DEC-007)`))
    }

    // boolean-prefix-convention (DEC-031, hard): is* / has*, запрет show*
    if (isBooleanLike && !/^(is|has)[A-Z]/.test(propName)) {
      let hint: string
      const prefixed = propName.match(/^(is|has)([a-z].*)$/)
      if (/^show[A-Z]/.test(propName)) {
        hint = 'префикс show* запрещён — переименовать в has*'
      } else if (prefixed) {
        // Prefix is there, but the next letter is lowercase — camelCase break
        const suggested = prefixed[1] + prefixed[2].charAt(0).toUpperCase() + prefixed[2].slice(1)
        hint = `после префикса ${prefixed[1]}* должна идти заглавная буква — «${suggested}»`
      } else {
        hint = 'boolean-свойство обязано начинаться с is* (runtime-state) или has* (toggle видимости)'
      }
      findings.push(dsNamingFinding(root, `Свойство ${propName}`, 'boolean-prefix-convention',
        `«${propName}» — ${hint} (boolean-prefix-convention, DEC-031)`))
    }

    // Tier-1 glossary (DEC-025, soft) + канонические enum-values
    if (def.type === 'VARIANT') {
      const canonical = DS_GLOSSARY_ANTINAMES[propName]
      if (canonical) {
        findings.push(dsNamingFinding(root, `Ось ${propName}`, 'component-property-tier1-glossary',
          `ось «${propName}» — использовать каноническое имя «${canonical}» (component-property-tier1-glossary, DEC-025)`))
      }
      const options: string[] = Array.isArray(def.variantOptions) ? def.variantOptions : []
      const checkEnum = (enumValues: string[], ruleId: string, dec: string) => {
        const bad = options.filter(o => enumValues.indexOf(o) === -1)
        if (bad.length > 0) {
          findings.push(dsNamingFinding(root, `Ось ${propName}`, ruleId,
            `значения вне канонического enum: ${bad.join(', ')} (допустимо: ${enumValues.join(' | ')}); расширение — только через bump правил (${dec})`))
        }
      }
      if (propName === 'state') checkEnum(DS_STATE_ENUM, 'state-axis-canonical-enum', 'DEC-030')
      if (propName === 'variant') checkEnum(DS_VARIANT_ENUM, 'component-property-tier1-glossary', 'DEC-025')
      if (propName === 'labelPosition') checkEnum(DS_LABELPOS_ENUM, 'component-property-tier1-glossary', 'DEC-025')
      if (propName === 'priority') checkEnum(DS_PRIORITY_ENUM, 'component-property-tier1-glossary', 'DEC-025')
    }
  }

  return findings
}

// Collect components instantiated inside a variant — the dev's import list.
// Top-level instances only: what's inside an INSTANCE is its master's business.
const collectUsedComponents = async (root: ComponentNode): Promise<string[]> => {
  const used = new Set<string>()

  const walk = async (node: SceneNode): Promise<void> => {
    if (!('children' in node) || !node.children) return
    for (const child of node.children) {
      if (child.type === 'INSTANCE') {
        try {
          const main = await (child as InstanceNode).getMainComponentAsync()
          if (main) {
            const setName = main.parent && main.parent.type === 'COMPONENT_SET'
              ? (main.parent.name || '').trim()
              : ''
            const name = setName || (main.name || '').trim()
            if (name) used.add(main.remote ? `${name} — внешняя библиотека` : name)
          }
        } catch (e) { /* dangling instance — skip */ }
        continue // не спускаемся внутрь инстанса
      }
      await walk(child)
    }
  }

  try {
    await walk(root)
  } catch (e) {
    console.error('Error in collectUsedComponents:', e)
  }
  return Array.from(used).sort()
}

// layer-naming-camelcase (DEC-008, hard): walk layers inside a variant.
// Skips: INSTANCE nodes (named after their master component, PascalCase is
// expected) and auto-named TEXT (name mirrors content — not a naming decision).
const checkLayerNaming = (root: ComponentNode): UnboundProperty[] => {
  const findings: UnboundProperty[] = []

  const walk = (node: SceneNode, path: string) => {
    if (!('children' in node) || !node.children) return
    for (const child of node.children) {
      if (child.type === 'INSTANCE') continue
      const childName = (child.name || '').trim()
      const isAutoText = child.type === 'TEXT' && (child as TextNode).autoRename
      if (!isAutoText && childName && !DS_CAMEL.test(childName)) {
        findings.push({
          type: 'tokenMisuse',
          property: 'Имя слоя',
          currentValue: safeText(`«${childName}» — имя слоя должно быть camelCase (layer-naming-camelcase, DEC-008)`),
          nodePath: safeText(path ? `${path} > ${childName}` : childName),
          nodeId: child.id,
          ruleId: 'layer-naming-camelcase',
          fixRename: dsToCamelCase(childName)
        })
      }
      walk(child, path ? `${path} > ${childName}` : childName)
    }
  }

  try {
    walk(root, '')
  } catch (e) {
    console.error('Error in checkLayerNaming:', e)
  }
  return findings
}

const XIcon = ({ color = "#F44336", size = 16 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 6 6 18"/>
      <path d="m6 6 12 12"/>
    </svg>`}
  />
)

const CircleCheckIcon = ({ color = "#00C853", size = 16 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>`}
  />
)

const ExternalLinkIcon = ({ color = "#666666", size = 12 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 3h6v6"/>
      <path d="M10 14 21 3"/>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </svg>`}
  />
)

const ChevronDownIcon = ({ color = "#666666", size = 12 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m6 9 6 6 6-6"/>
    </svg>`}
  />
)

const ChevronRightIcon = ({ color = "#666666", size = 12 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m9 18 6-6-6-6"/>
    </svg>`}
  />
)

const CurrentPageIcon = ({ color = "#1976D2", size = 20 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 10V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M16 14a2 2 0 0 0-2 2"/>
      <path d="M20 14a2 2 0 0 1 2 2"/>
      <path d="M20 22a2 2 0 0 0 2-2"/>
      <path d="M16 22a2 2 0 0 1-2-2"/>
    </svg>`}
  />
)

const SelectionIcon = ({ color = "#2E7D32", size = 20 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
      <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
      <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
      <path d="M7 12h10"/>
    </svg>`}
  />
)

// Component Set Icon (Dashed border frame with center diamond)
const ComponentSetIcon = ({ color = "#000000", size = 16 }: { color?: string, size?: number }) => (
  <SVG 
    src={`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_17_5465)">
<path d="M1 14C1 14.5523 1.44772 15 2 15H3.5V16H2C0.895431 16 0 15.1046 0 14V12.5H1V14Z" fill="${color}"/>
<path d="M9.5 16H6.5V15H9.5V16Z" fill="${color}"/>
<path d="M16 14C16 15.1046 15.1046 16 14 16H12.5V15H14C14.5523 15 15 14.5523 15 14V12.5H16V14Z" fill="${color}"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M7.5 8.60254C7.77597 8.32655 8.22403 8.32655 8.5 8.60254L9.66992 9.77344C9.94584 10.0494 9.94589 10.4965 9.66992 10.7725L8.5 11.9434C8.22406 12.2193 7.77597 12.2193 7.5 11.9434L6.33008 10.7725C6.05411 10.4965 6.05412 10.0494 6.33008 9.77344L7.5 8.60254ZM6.88379 10.2725L8 11.3887L9.11523 10.2725L8 9.15625L6.88379 10.2725ZM9.27344 10.2314C9.27872 10.2446 9.2812 10.2585 9.28125 10.2725C9.28118 10.2441 9.27068 10.216 9.24902 10.1943L9.27344 10.2314ZM6.36426 9.96582C6.32346 10.0276 6.2968 10.0958 6.2832 10.166C6.30364 10.0609 6.35414 9.96031 6.43555 9.87891L6.36426 9.96582Z" fill="${color}"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M5.22754 6.33008C5.5035 6.05411 5.95059 6.05412 6.22656 6.33008L7.39746 7.5C7.67327 7.77587 7.67311 8.22305 7.39746 8.49902L6.22656 9.66992C5.95062 9.94583 5.50351 9.94579 5.22754 9.66992L4.05664 8.5C3.78068 8.22404 3.78068 7.77596 4.05664 7.5L5.22754 6.33008ZM5.76855 9.27344C5.75511 9.27886 5.74084 9.2813 5.72656 9.28125C5.75529 9.28143 5.78374 9.27094 5.80566 9.24902L5.76855 9.27344ZM4.61133 8L5.72656 9.11523L6.84277 8L5.72656 6.88379L4.61133 8ZM6.0332 6.36426C6.06419 6.38468 6.09382 6.40828 6.12109 6.43555C6.06669 6.38114 6.00363 6.34062 5.93652 6.31348L6.0332 6.36426Z" fill="${color}"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M9.77344 6.33008C10.0494 6.05413 10.4965 6.05412 10.7725 6.33008L11.9434 7.5C12.2192 7.77597 12.2193 8.22406 11.9434 8.5L10.7725 9.66992C10.4965 9.94583 10.0494 9.94578 9.77344 9.66992L8.60254 8.5C8.32661 8.22404 8.32661 7.77596 8.60254 7.5L9.77344 6.33008ZM10.2305 9.27344C10.2439 9.27896 10.2581 9.28219 10.2725 9.28223C10.2442 9.28211 10.216 9.2706 10.1943 9.24902L10.2305 9.27344ZM9.15625 8L10.2725 9.11523L11.3887 8L10.2725 6.88379L9.15625 8ZM10.166 6.2832C10.0608 6.30357 9.96037 6.3541 9.87891 6.43555L9.9668 6.36426C10.0283 6.3237 10.0961 6.29679 10.166 6.2832Z" fill="${color}"/>
<path d="M1 9.5H0V6.5H1V9.5Z" fill="${color}"/>
<path d="M16 9.5H15V6.5H16V9.5Z" fill="${color}"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M7.5 4.05664C7.77597 3.78068 8.22403 3.78068 8.5 4.05664L9.66992 5.22754C9.94584 5.50351 9.94588 5.95062 9.66992 6.22656L8.5 7.39746C8.25861 7.63885 7.88559 7.66919 7.61133 7.48828L7.50098 7.39746L6.33008 6.22656C6.05412 5.9506 6.05412 5.5035 6.33008 5.22754L7.5 4.05664ZM6.88379 5.72656L8 6.84277L9.11523 5.72656L8 4.61133L6.88379 5.72656ZM6.36426 6.03418C6.38457 6.06491 6.40848 6.09403 6.43555 6.12109L6.36426 6.03418C6.34394 6.00335 6.32703 5.96998 6.31348 5.93652L6.36426 6.03418Z" fill="${color}"/>
<path d="M3.5 1H2C1.44772 1 1 1.44772 1 2V3.5H0V2C0 0.895431 0.895431 0 2 0H3.5V1Z" fill="${color}"/>
<path d="M14 0C15.1046 0 16 0.895431 16 2V3.5H15V2C15 1.44772 14.5523 1 14 1H12.5V0H14Z" fill="${color}"/>
<path d="M9.5 1H6.5V0H9.5V1Z" fill="${color}"/>
</g>
<defs>
<clipPath id="clip0_17_5465">
<rect width="16" height="16" fill="white"/>
</clipPath>
</defs>
</svg>`}
  />
)

// Single Component Icon  
const ComponentIcon = ({ color = "#000000", size = 16 }: { color?: string, size?: number }) => (
  <SVG 
    src={`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_17_5462)">
<path fill-rule="evenodd" clip-rule="evenodd" d="M3.30621 5.5061L0.969605 7.84269C0.882818 7.92948 0.882819 8.07019 0.969605 8.15697L3.30621 10.4936C3.39299 10.5804 3.53369 10.5804 3.62048 10.4936L5.95708 8.15697C6.04386 8.07019 6.04386 7.92948 5.95708 7.84269L3.62048 5.5061C3.53369 5.41931 3.39299 5.41931 3.30621 5.5061ZM7.21416 9.41404L4.87755 11.7507C4.44364 12.1845 4.44364 12.8881 4.87755 13.322L7.21416 15.6586C7.64808 16.0925 8.35159 16.0925 8.78551 15.6586L11.1221 13.322C11.556 12.8881 11.556 12.1845 11.1221 11.7507L8.78551 9.41404C8.35159 8.98009 7.64808 8.98009 7.21416 9.41404ZM7.21463 6.58609C7.21479 6.58625 7.21447 6.58593 7.21463 6.58609L4.87755 4.24901C4.44364 3.8151 4.44364 3.11158 4.87755 2.67766L7.21416 0.341062C7.64808 -0.0928541 8.35159 -0.0928541 8.78551 0.341062L11.1221 2.67766C11.556 3.11158 11.556 3.8151 11.1221 4.24901L8.78551 6.58562C8.35175 7.01938 7.64858 7.01954 7.21463 6.58609ZM6.58609 8.78504C6.58624 8.78489 6.58593 8.78519 6.58609 8.78504L4.24902 11.1221C3.8151 11.556 3.11158 11.556 2.67767 11.1221L0.341062 8.7855C-0.0928541 8.35159 -0.0928541 7.64807 0.341062 7.21416L2.67767 4.87756C3.11158 4.44364 3.8151 4.44364 4.24902 4.87756L6.58562 7.21416C7.01938 7.64792 7.01953 8.35108 6.58609 8.78504ZM5.50609 3.62047L7.8427 5.95708C7.92948 6.04387 8.07018 6.04387 8.15697 5.95708L10.4936 3.62047C10.5803 3.53369 10.5803 3.39299 10.4936 3.3062L8.15697 0.9696C8.07018 0.882818 7.92948 0.882818 7.8427 0.9696L5.50609 3.3062C5.41931 3.39299 5.41931 3.53369 5.50609 3.62047ZM11.7506 4.87756L9.414 7.21416C8.98014 7.64807 8.98014 8.35159 9.414 8.7855L11.7506 11.1221C12.1846 11.556 12.888 11.556 13.322 11.1221L15.6586 8.7855C16.0925 8.35159 16.0925 7.64807 15.6586 7.21416L13.322 4.87756C12.888 4.44364 12.1846 4.44364 11.7506 4.87756ZM12.3792 5.50609L10.0426 7.84269C9.95578 7.92948 9.95578 8.07019 10.0426 8.15697L12.3792 10.4936C12.466 10.5804 12.6067 10.5804 12.6935 10.4936L15.0301 8.15697C15.1168 8.07019 15.1168 7.92948 15.0301 7.84269L12.6935 5.50609C12.6067 5.41931 12.466 5.41931 12.3792 5.50609ZM10.4936 12.3792L8.15697 10.0426C8.07018 9.95582 7.92948 9.95582 7.8427 10.0426L5.50609 12.3792C5.41931 12.466 5.41931 12.6067 5.50609 12.6934L7.8427 15.03C7.92948 15.1169 8.07018 15.1169 8.15697 15.03L10.4936 12.6934C10.5803 12.6067 10.5803 12.466 10.4936 12.3792Z" fill="${color}" fill-opacity="0.9"/>
</g>
<defs>
<clipPath id="clip0_17_5462">
<rect width="16" height="16" fill="white"/>
</clipPath>
</defs>
</svg>`}
  />
)

const SettingsIcon = ({ color = "#666666", size = 16 }: { color?: string, size?: number }) => (
  <SVG
    src={`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>`}
  />
)

interface SettingsState {
  showMissingDescription: boolean
  showMissingDocsLink: boolean
  showMissingVariables: boolean
  showTokenMisuse: boolean
  showUsedComponents: boolean
  // DS rules group (per-rule toggles)
  showRuleSpacingCategory: boolean
  showRuleLayoutVocab: boolean
  showRuleRegionScope: boolean
  showRuleSemanticLayer: boolean
  showRuleTierDiscipline: boolean
  showRuleComponentTier: boolean
  showRuleGradientStops: boolean
  showRuleComponentName: boolean
  showRuleSubComponentName: boolean
  showRulePropCamelCase: boolean
  showRuleBooleanPrefix: boolean
  showRuleGlossary: boolean
  showRuleLayerNaming: boolean
  hideZeroValues: boolean
  showFillValues: boolean
  // Stroke group
  showStrokeColorValues: boolean
  showStrokeWeightValues: boolean
  // Text group
  showFontFamilyValues: boolean
  showFontSizeValues: boolean
  showLineHeightValues: boolean
  // Spacing group
  showPaddingValues: boolean
  showPaddingTopValues: boolean
  showPaddingRightValues: boolean
  showPaddingBottomValues: boolean
  showPaddingLeftValues: boolean
  showItemSpacingValues: boolean
  // Corner Radius group
  showAllCornersValues: boolean
  showTopLeftRadiusValues: boolean
  showTopRightRadiusValues: boolean
  showBottomLeftRadiusValues: boolean
  showBottomRightRadiusValues: boolean
  // Effects group
  showEffectValues: boolean
  showEffectColorValues: boolean
  showEffectValuesValues: boolean
  showAppearanceValues: boolean
}

function Widget() {
  const [auditData, setAuditData] = useSyncedState<ComponentAuditData[]>('auditData', [])
  const [isDeepScanning, setIsDeepScanning] = useSyncedState('isDeepScanning', false)
  const [lastScanTime, setLastScanTime] = useSyncedState('lastScanTime', '')
  const [lastScanMode, setLastScanMode] = useSyncedState<'page' | 'selection'>('lastScanMode', 'page')
  const [pageProgress, setPageProgress] = useSyncedState<PageProgress[]>('pageProgress', [])
  const [currentProgress, setCurrentProgress] = useSyncedState('currentProgress', '')
  const [expandedPages, setExpandedPages] = useSyncedState<string[]>('expandedPages', [])
  const [expandedComponents, setExpandedComponents] = useSyncedState<string[]>('expandedComponents', [])
  const [pageDisplayCounts, setPageDisplayCounts] = useSyncedState<Record<string, number>>('pageDisplayCounts', {})
  const [isProgressExpanded, setIsProgressExpanded] = useSyncedState('isProgressExpanded', true)
  const [isSettingsExpanded, setIsSettingsExpanded] = useSyncedState('isSettingsExpanded', false)
  const [isIndividualPropsExpanded, setIsIndividualPropsExpanded] = useSyncedState('isIndividualPropsExpanded', false)
  const [selectionError, setSelectionError] = useSyncedState<string | null>('selectionError', null)
  const [settings, setSettings] = useSyncedState<SettingsState>('settings', {
    showMissingDescription: true,
    showMissingDocsLink: true,
    showMissingVariables: true,
    showTokenMisuse: true,
    showUsedComponents: true,
    showRuleSpacingCategory: true,
    showRuleLayoutVocab: true,
    showRuleRegionScope: true,
    showRuleSemanticLayer: true,
    showRuleTierDiscipline: true,
    showRuleComponentTier: true,
    showRuleGradientStops: true,
    showRuleComponentName: true,
    showRuleSubComponentName: true,
    showRulePropCamelCase: true,
    showRuleBooleanPrefix: true,
    showRuleGlossary: true,
    showRuleLayerNaming: true,
    hideZeroValues: true,
    showFillValues: true,
    // Stroke group
    showStrokeColorValues: true,
    showStrokeWeightValues: true,
    // Text group
    showFontFamilyValues: true,
    showFontSizeValues: true,
    showLineHeightValues: true,
    // Spacing group
    showPaddingValues: true,
    showPaddingTopValues: true,
    showPaddingRightValues: true,
    showPaddingBottomValues: true,
    showPaddingLeftValues: true,
    showItemSpacingValues: true,
    // Corner Radius group
    showAllCornersValues: true,
    showTopLeftRadiusValues: true,
    showTopRightRadiusValues: true,
    showBottomLeftRadiusValues: true,
    showBottomRightRadiusValues: true,
    // Effects group
    showEffectValues: true,
    showEffectColorValues: true,
    showEffectValuesValues: true,
    showAppearanceValues: false
  })

  // Ignored findings: stable keys, survive rescans (synced state)
  const [ignoredFindings, setIgnoredFindings] = useSyncedState<string[]>('ignoredFindings', [])

  const CHUNK_SIZE = 25
  const LOAD_MORE_SIZE = 25
  const SELECTION_CHUNK_SIZE = 50  // Larger initial load for selection scans

  const findingKey = (prop: UnboundProperty): string =>
    [prop.nodeId || '', prop.ruleId || prop.type, prop.property, prop.currentValue || ''].join('|')

  const toggleIgnoreFinding = (prop: UnboundProperty) => {
    const key = findingKey(prop)
    if (ignoredFindings.indexOf(key) === -1) {
      setIgnoredFindings([...ignoredFindings, key])
    } else {
      setIgnoredFindings(ignoredFindings.filter(k => k !== key))
    }
  }

  const removeFindingFromAudit = (key: string) => {
    setAuditData(auditData.map(c => {
      const rest = c.unboundProperties.filter(p => findingKey(p) !== key)
      if (rest.length === c.unboundProperties.length) return c
      return { ...c, unboundProperties: rest, hasUnboundProperties: rest.length > 0 }
    }))
  }

  const applyFixBind = async (componentId: string, prop: UnboundProperty) => {
    if (!prop.fixBindVariableId || !prop.fixBindField || !prop.nodeId) return
    try {
      const node: any = await figma.getNodeByIdAsync(prop.nodeId)
      const variable = await figma.variables.getVariableByIdAsync(prop.fixBindVariableId)
      if (!node || !variable) {
        figma.notify('❌ Узел или переменная не найдены — пересканируйте')
        return
      }
      const paintMatch = /^(fills|strokes)\[(\d+)\]$/.exec(prop.fixBindField)
      if (paintMatch) {
        // Paints are rebound through the paint object, not setBoundVariable
        const paintField = paintMatch[1]
        const paintIndex = Number(paintMatch[2])
        const paints = node[paintField]
        if (!Array.isArray(paints) || !paints[paintIndex]) {
          figma.notify('❌ Заливка изменилась — пересканируйте')
          return
        }
        const next = paints.slice()
        next[paintIndex] = figma.variables.setBoundVariableForPaint(next[paintIndex], 'color', variable)
        node[paintField] = next
      } else if (prop.fixBindField === 'cornerRadius') {
        // Unified radius is not directly bindable — bind all four corners
        for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) {
          node.setBoundVariable(f, variable)
        }
      } else {
        node.setBoundVariable(prop.fixBindField, variable)
      }
      removeFindingFromAudit(findingKey(prop))
      figma.notify(`✅ Привязан «${variable.name}»`)
    } catch (e) {
      console.error('Error applying bind fix:', e)
      figma.notify('❌ Не удалось привязать переменную', { error: true })
    }
  }

  const applyFixRename = async (componentId: string, prop: UnboundProperty) => {
    if (!prop.fixRename || !prop.nodeId) return
    try {
      const node = await figma.getNodeByIdAsync(prop.nodeId)
      if (!node) {
        figma.notify('❌ Узел не найден — пересканируйте')
        return
      }
      node.name = prop.fixRename
      removeFindingFromAudit(findingKey(prop))
      figma.notify(`✅ Переименовано: «${prop.fixRename}»`)
    } catch (e) {
      console.error('Error applying fix:', e)
      figma.notify('❌ Не удалось переименовать (узел заблокирован?)', { error: true })
    }
  }

  const getNodePath = (node: SceneNode, rootNode: SceneNode): string => {
    const path: string[] = []
    let current: SceneNode | null = node
    
    while (current && current !== rootNode && current.parent) {
      if (current.name) {
        path.unshift(current.name)
      }
      current = current.parent as SceneNode
    }
    
    return path.length > 0 ? path.join(' > ') : 'Root'
  }

  const formatColor = (color: RGB): string => {
    const r = Math.round(color.r * 255)
    const g = Math.round(color.g * 255)
    const b = Math.round(color.b * 255)
    return `rgb(${r}, ${g}, ${b})`
  }

  const checkForUnboundProperties = (node: ComponentNode): { hasUnbound: boolean; properties: UnboundProperty[] } => {
    const unboundProperties: UnboundProperty[] = [];

    // Attach a bind-suggestion when a token with this exact value exists
    const withSuggestion = (finding: UnboundProperty, value: number, category: string, field: string): UnboundProperty => {
      const s = dsSuggestToken(value, category)
      if (s) {
        finding.fixBindVariableId = s.id
        finding.fixBindName = s.name
        finding.fixBindField = field
      }
      return finding
    }

    const checkNodeForUnboundProps = (node: SceneNode, path: string = ''): void => {
      // Ensure we never create empty currentPath using safeText
      const safeName = safeText(node.name) !== 'N/A' ? safeText(node.name) : (node.type || 'Node');
      const currentPath = path ? `${path} > ${safeName}` : safeName;
      

      if ('fills' in node && node.fills && node.fills !== figma.mixed) {
        const fills = node.fills as readonly Paint[];
        fills.forEach((fill, index) => {
          if (fill.type === 'SOLID') {
            // Check for fill color variables - stored in boundVariables.fills array  
            const fillBindings = node.boundVariables && 
                                node.boundVariables.fills &&
                                Array.isArray(node.boundVariables.fills) &&
                                node.boundVariables.fills[index];
            const isBound = fillBindings && 
                           typeof fillBindings === 'object' &&
                           (fillBindings as any).type === 'VARIABLE_ALIAS';
            
            const hasStyle = 'fillStyleId' in node && 
                           node.fillStyleId && 
                           node.fillStyleId !== '';
            
            if (!isBound && !hasStyle) {
              unboundProperties.push({
                type: 'fill',
                property: fills.length > 1 ? `Fill ${index + 1}` : 'Fill',
                currentValue: safeText(formatColor(fill.color)),
                nodePath: safeText(currentPath),
                nodeId: node.id
              });
            }
          }
        });
      }

      // Stroke checking - report color and weight separately
      if ('strokes' in node && node.strokes && node.strokes.length > 0) {
        const hasVisibleStrokes = node.strokes.some((stroke: Paint) => stroke.visible !== false);
        
        if (hasVisibleStrokes) {
          // Check stroke colors
          node.strokes.forEach((stroke, originalIndex) => {
            if (stroke.visible === false) return;
            
            if (stroke.type === 'SOLID') {
              const strokeBindings = node.boundVariables && 
                                    node.boundVariables.strokes &&
                                    Array.isArray(node.boundVariables.strokes) &&
                                    node.boundVariables.strokes[originalIndex];
              const isColorBound = strokeBindings && 
                                  typeof strokeBindings === 'object' &&
                                  (strokeBindings as any).type === 'VARIABLE_ALIAS';
              
              const hasStyle = 'strokeStyleId' in node && 
                             node.strokeStyleId && 
                             node.strokeStyleId !== '';
              
              if (!isColorBound && !hasStyle) {
                const visibleStrokesCount = node.strokes.filter(s => s.visible !== false).length;
                unboundProperties.push({
                  type: 'stroke',
                  property: visibleStrokesCount > 1 ? `Stroke ${originalIndex + 1} Color` : 'Stroke Color',
                  currentValue: safeText(formatColor(stroke.color)),
                  nodePath: safeText(currentPath),
                  nodeId: node.id
                });
              }
            }
          });
          
          // Check stroke weight separately
          if ('strokeWeight' in node) {
            // Check if strokeWeight is a single value or mixed (individual values)
            if (typeof node.strokeWeight === 'number') {
              // Single stroke weight value - check both strokeWeight and individual sides
              // Figma can store uniform stroke weight variables as individual side properties
              const boundVar = node.boundVariables && node.boundVariables.strokeWeight;
              const isWeightBound = boundVar && 
                                   typeof boundVar === 'object' &&
                                   (boundVar as any).type === 'VARIABLE_ALIAS';
              
              // Also check if all individual sides have the same variable binding
              const topBound = node.boundVariables && (node.boundVariables as any).strokeTopWeight;
              const rightBound = node.boundVariables && (node.boundVariables as any).strokeRightWeight;
              const bottomBound = node.boundVariables && (node.boundVariables as any).strokeBottomWeight;
              const leftBound = node.boundVariables && (node.boundVariables as any).strokeLeftWeight;
              
              const hasIndividualBindings = (topBound || rightBound || bottomBound || leftBound);
              const allSidesBound = topBound && rightBound && bottomBound && leftBound &&
                                   topBound.type === 'VARIABLE_ALIAS' &&
                                   rightBound.type === 'VARIABLE_ALIAS' &&
                                   bottomBound.type === 'VARIABLE_ALIAS' &&
                                   leftBound.type === 'VARIABLE_ALIAS';
              
              if (!isWeightBound && !allSidesBound) {
                unboundProperties.push(withSuggestion({
                  type: 'stroke',
                  property: 'Stroke Weight',
                  currentValue: safeText(`${node.strokeWeight}px`),
                  nodePath: safeText(currentPath),
                  nodeId: node.id
                }, node.strokeWeight, 'borderWidth', 'strokeWeight'));
              }
            } else if (node.strokeWeight === figma.mixed) {
              // Individual stroke weights - check each side
              const strokeSides = [
                { key: 'strokeTopWeight', name: 'Stroke Top Weight', value: (node as any).strokeTopWeight },
                { key: 'strokeRightWeight', name: 'Stroke Right Weight', value: (node as any).strokeRightWeight },
                { key: 'strokeBottomWeight', name: 'Stroke Bottom Weight', value: (node as any).strokeBottomWeight },
                { key: 'strokeLeftWeight', name: 'Stroke Left Weight', value: (node as any).strokeLeftWeight }
              ];
              
              strokeSides.forEach(side => {
                if (typeof side.value === 'number') {
                  const boundVar = node.boundVariables && (node.boundVariables as any)[side.key];
                  const isSideBound = boundVar && 
                                     typeof boundVar === 'object' &&
                                     (boundVar as any).type === 'VARIABLE_ALIAS';
                  
                  if (!isSideBound) {
                    unboundProperties.push(withSuggestion({
                      type: 'stroke',
                      property: side.name,
                      currentValue: safeText(`${side.value}px`),
                      nodePath: safeText(currentPath),
                      nodeId: node.id
                    }, side.value, 'borderWidth', side.key));
                  }
                }
              });
            }
          }
        }
      }

      if (node.type === 'TEXT') {
        const textNode = node as TextNode;
        
        const hasTextStyle = textNode.textStyleId && textNode.textStyleId !== '';
        
        if (!hasTextStyle) {
          const hasFontFamilyVar = textNode.boundVariables && textNode.boundVariables.fontFamily !== undefined;
          const hasFontSizeVar = textNode.boundVariables && textNode.boundVariables.fontSize !== undefined;
          const hasLineHeightVar = textNode.boundVariables && textNode.boundVariables.lineHeight !== undefined;
          
          if (!hasFontFamilyVar) {
            const fontFamilyValue = textNode.fontName !== figma.mixed ? 
              (textNode.fontName.family || 'Unknown Font') : 'Mixed';
            unboundProperties.push({
              type: 'text',
              property: 'Font Family',
              currentValue: safeText(fontFamilyValue),
              nodePath: safeText(currentPath),
              nodeId: node.id
            });
          }
          
          if (!hasFontSizeVar) {
            const fontSizeValue = textNode.fontSize !== figma.mixed ? 
              `${textNode.fontSize}px` : 'Mixed';
            unboundProperties.push({
              type: 'text',
              property: 'Font Size',
              currentValue: safeText(fontSizeValue),
              nodePath: safeText(currentPath),
              nodeId: node.id
            });
          }
          
          if (!hasLineHeightVar && textNode.lineHeight !== figma.mixed) {
            let lineHeightValue = '';
            
            if (typeof textNode.lineHeight === 'object') {
              if ('value' in textNode.lineHeight) {
                if (textNode.lineHeight.unit === 'PIXELS') {
                  lineHeightValue = `${textNode.lineHeight.value}px`;
                } else if (textNode.lineHeight.unit === 'PERCENT') {
                  lineHeightValue = `${textNode.lineHeight.value}%`;
                }
              } else if (textNode.lineHeight.unit === 'AUTO') {
                lineHeightValue = 'Auto';
              }
            } else if (typeof textNode.lineHeight === 'number') {
              lineHeightValue = `${textNode.lineHeight}`;
            }
            
            // Only add if we have a valid line height value
            if (textNode.lineHeight.unit !== 'AUTO' && lineHeightValue && lineHeightValue.trim()) {
              unboundProperties.push({
                type: 'text',
                property: 'Line Height',
                currentValue: safeText(lineHeightValue),
                nodePath: safeText(currentPath),
                nodeId: node.id
              });
            }
          }
        }
      }

      if ('cornerRadius' in node && node.cornerRadius !== undefined) {
        // Check if individual corner properties exist on the node
        // These exist as separate properties when corners have different values or individual variables
        const hasIndividualCorners = 'topLeftRadius' in node;
        
        if (hasIndividualCorners) {
          // Node has individual corner properties - check each one
          const corners = [
            { key: 'topLeftRadius', name: 'Top Left Radius', value: (node as any).topLeftRadius },
            { key: 'topRightRadius', name: 'Top Right Radius', value: (node as any).topRightRadius },
            { key: 'bottomLeftRadius', name: 'Bottom Left Radius', value: (node as any).bottomLeftRadius },
            { key: 'bottomRightRadius', name: 'Bottom Right Radius', value: (node as any).bottomRightRadius }
          ];
          
          corners.forEach(corner => {
            if (typeof corner.value === 'number' && corner.value >= 0) {
              const boundVar = node.boundVariables && (node.boundVariables as any)[corner.key];
              const hasCornerVar = boundVar && 
                                  typeof boundVar === 'object' &&
                                  boundVar.type === 'VARIABLE_ALIAS';
              
              if (!hasCornerVar) {
                unboundProperties.push(withSuggestion({
                  type: 'cornerRadius',
                  property: corner.name,
                  currentValue: safeText(`${corner.value}px`),
                  nodePath: safeText(currentPath),
                  nodeId: node.id
                }, corner.value, 'radius', corner.key));
              }
            }
          });
        } else if (typeof node.cornerRadius === 'number' && node.cornerRadius >= 0) {
          // Unified corner radius (all corners same, no individual properties)
          const hasUnifiedCornerVar = node.boundVariables &&
                                     node.boundVariables['cornerRadius' as keyof typeof node.boundVariables] &&
                                     typeof node.boundVariables['cornerRadius' as keyof typeof node.boundVariables] === 'object' &&
                                     (node.boundVariables['cornerRadius' as keyof typeof node.boundVariables] as any).type === 'VARIABLE_ALIAS';

          // Equal per-corner values keep cornerRadius as a plain number while the
          // binding lives on the individual corner keys — not a violation then
          const allCornersIndividuallyBound = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']
            .every(k => {
              const b = node.boundVariables && (node.boundVariables as any)[k];
              return b && typeof b === 'object' && b.type === 'VARIABLE_ALIAS';
            });

          if (!hasUnifiedCornerVar && !allCornersIndividuallyBound) {
            unboundProperties.push(withSuggestion({
              type: 'cornerRadius',
              property: 'All Corners',
              currentValue: safeText(`${node.cornerRadius}px`),
              nodePath: safeText(currentPath),
              nodeId: node.id
            }, node.cornerRadius as number, 'radius', 'cornerRadius'));
          }
        }
      }

      if (node.type === 'FRAME' || node.type === 'COMPONENT') {
        const layoutNode = node as FrameNode;
        
        if ('layoutMode' in layoutNode && layoutNode.layoutMode !== 'NONE') {
          // Check for hardcoded itemSpacing values
          // Skip spacing checks if primaryAxisAlignItems is 'SPACE_BETWEEN' (indicates "auto" spacing)
          const isAutoSpacing = layoutNode.primaryAxisAlignItems === 'SPACE_BETWEEN';
          // Grid layout: itemSpacing/gap are stale flow-layout leftovers, not what the
          // grid actually uses — checking them produces false positives
          const isGridLayout = (layoutNode as any).layoutMode === 'GRID';

          // Check gap property (newer Figma property for spacing between items)
          if (!isGridLayout && 'gap' in layoutNode && typeof (layoutNode as any).gap === 'number' && !isAutoSpacing) {
            const gap = (layoutNode as any).gap;
            const boundVar = layoutNode.boundVariables && (layoutNode.boundVariables as any).gap;
            const hasGapVar = boundVar && 
                             typeof boundVar === 'object' &&
                             boundVar.type === 'VARIABLE_ALIAS';
            
            if (!hasGapVar) {
              unboundProperties.push(withSuggestion({
                type: 'spacing',
                property: 'Gap',
                currentValue: safeText(`${gap}px`),
                nodePath: safeText(currentPath),
                nodeId: node.id
              }, gap, 'gap', 'itemSpacing'));
            }
          }
          
          // Check itemSpacing property (older property, still used in some cases)
          if (!isGridLayout && 'itemSpacing' in layoutNode && layoutNode.itemSpacing >= 0 && !isAutoSpacing) {
            const boundVar = layoutNode.boundVariables && layoutNode.boundVariables.itemSpacing;
            const hasItemSpacingVar = boundVar && 
                                     typeof boundVar === 'object' &&
                                     (boundVar as any).type === 'VARIABLE_ALIAS';
            
            if (!hasItemSpacingVar) {
              unboundProperties.push(withSuggestion({
                type: 'spacing',
                property: 'Item Spacing',
                currentValue: safeText(`${layoutNode.itemSpacing}px`),
                nodePath: safeText(currentPath),
                nodeId: node.id
              }, layoutNode.itemSpacing, 'gap', 'itemSpacing'));
            }
          }

          if ('paddingTop' in layoutNode) {
            const paddings = [
              { key: 'paddingTop', name: 'Padding Top', value: layoutNode.paddingTop },
              { key: 'paddingRight', name: 'Padding Right', value: layoutNode.paddingRight },
              { key: 'paddingBottom', name: 'Padding Bottom', value: layoutNode.paddingBottom },
              { key: 'paddingLeft', name: 'Padding Left', value: layoutNode.paddingLeft }
            ];
            
            paddings.forEach(padding => {
              if (padding.value >= 0) {
                const boundVar = layoutNode.boundVariables && 
                               layoutNode.boundVariables[padding.key as keyof typeof layoutNode.boundVariables];
                const hasPaddingVar = boundVar && 
                                     typeof boundVar === 'object' &&
                                     (boundVar as any).type === 'VARIABLE_ALIAS';
                if (!hasPaddingVar) {
                  unboundProperties.push(withSuggestion({
                    type: 'spacing',
                    property: padding.name,
                    currentValue: safeText(`${padding.value}px`),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  }, padding.value, 'padding', padding.key));
                }
              }
            });
          }
        }
      }

      if ('effects' in node && node.effects && node.effects.length > 0) {
        const hasEffectStyle = 'effectStyleId' in node && 
                              node.effectStyleId && 
                              node.effectStyleId !== '';
        
        if (!hasEffectStyle) {
          node.effects.forEach((effect, index) => {
            if (effect.visible !== false) {
              const effectLabel = node.effects.length > 1 ? `Effect ${index + 1}` : 'Effect';
              
              // Check effect.boundVariables for individual property bindings
              const effectBoundVars = (effect as any).boundVariables;
              
              if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
                const shadow = effect as DropShadowEffect | InnerShadowEffect;
                
                // Check if color is bound
                const isColorBound = effectBoundVars && 
                                    effectBoundVars.color &&
                                    effectBoundVars.color.type === 'VARIABLE_ALIAS';
                
                // Check if offsetX/offsetY are bound
                const isOffsetXBound = effectBoundVars && 
                                      effectBoundVars.offsetX &&
                                      effectBoundVars.offsetX.type === 'VARIABLE_ALIAS';
                const isOffsetYBound = effectBoundVars && 
                                      effectBoundVars.offsetY &&
                                      effectBoundVars.offsetY.type === 'VARIABLE_ALIAS';
                
                // Check if radius is bound
                const isRadiusBound = effectBoundVars && 
                                     effectBoundVars.radius &&
                                     effectBoundVars.radius.type === 'VARIABLE_ALIAS';
                
                // Check if spread is bound
                const isSpreadBound = effectBoundVars && 
                                     effectBoundVars.spread &&
                                     effectBoundVars.spread.type === 'VARIABLE_ALIAS';
                
                // Add color if not bound
                if (!isColorBound && 'color' in shadow && shadow.color) {
                  const color = shadow.color;
                  const colorValue = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${color.a !== undefined ? color.a.toFixed(2) : 1})`;
                  unboundProperties.push({
                    type: 'effect',
                    property: `${effectLabel} Color`,
                    currentValue: safeText(colorValue),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  });
                }
                
                // Add offset if not bound
                if (!isOffsetXBound || !isOffsetYBound) {
                  unboundProperties.push({
                    type: 'effect',
                    property: `${effectLabel} Offset`,
                    currentValue: safeText(`x: ${shadow.offset.x}, y: ${shadow.offset.y}`),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  });
                }
                
                // Add blur if not bound
                if (!isRadiusBound) {
                  unboundProperties.push({
                    type: 'effect',
                    property: `${effectLabel} Blur`,
                    currentValue: safeText(`${shadow.radius}`),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  });
                }
                
                // Add spread if not bound
                if (!isSpreadBound && shadow.spread !== undefined) {
                  unboundProperties.push({
                    type: 'effect',
                    property: `${effectLabel} Spread`,
                    currentValue: safeText(`${shadow.spread || 0}`),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  });
                }
                
              } else if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
                const blur = effect as BlurEffect;
                
                // Check if radius is bound
                const isRadiusBound = effectBoundVars && 
                                     effectBoundVars.radius &&
                                     effectBoundVars.radius.type === 'VARIABLE_ALIAS';
                
                // Add blur if not bound
                if (!isRadiusBound) {
                  unboundProperties.push({
                    type: 'effect',
                    property: `${effectLabel} Blur`,
                    currentValue: safeText(`${blur.radius}`),
                    nodePath: safeText(currentPath),
                    nodeId: node.id
                  });
                }
              }
            }
          });
        }
      }


      // Check opacity property (layer transparency)
      // Note: We check ALL opacity values (including 100%) because a hardcoded 100% 
      // is still a hardcoded value that should potentially use a variable
      if ('opacity' in node && typeof node.opacity === 'number') {
        // Check if opacity is bound to a variable
        // boundVariables.opacity will be an object like { type: "VARIABLE_ALIAS", id: "VariableID:..." } if bound
        const boundVar = node.boundVariables && (node.boundVariables as any).opacity;
        const hasOpacityVar = boundVar && 
                             typeof boundVar === 'object' &&
                             boundVar.type === 'VARIABLE_ALIAS';
        
        // Report any opacity value that doesn't have a variable (including 100%)
        if (!hasOpacityVar) {
          unboundProperties.push({
            type: 'appearance',
            property: 'Opacity',
            currentValue: safeText(`${Math.round(node.opacity * 100)}%`),
            nodePath: safeText(currentPath),
            nodeId: node.id
          });
        }
      }

      if ('children' in node && node.children) {
        node.children.forEach(child => {
          checkNodeForUnboundProps(child, currentPath);
        });
      }
    };

    try {
      checkNodeForUnboundProps(node);
      return {
        hasUnbound: unboundProperties.length > 0,
        properties: unboundProperties
      };
    } catch (error) {
      console.error('Error checking unbound properties:', error);
      return { hasUnbound: false, properties: [] };
    }
  };

  const isHiddenFromPublishing = (name: string): boolean => {
    return name.startsWith('.') || name.startsWith('_')
  }

  const hasDescription = (component: ComponentNode): boolean => {
    return component.description !== undefined && component.description.trim() !== ''
  }

  const hasDocumentationLink = (component: ComponentNode): boolean => {
    return component.documentationLinks !== undefined && 
           component.documentationLinks.length > 0 &&
           component.documentationLinks.some(link => link.uri.trim() !== '')
  }

  const processPageComponents = async (page: PageNode): Promise<ComponentAuditData[]> => {
    const components = page.findAll(node => node.type === 'COMPONENT') as ComponentNode[]
    const componentSets = page.findAll(node => node.type === 'COMPONENT_SET') as ComponentSetNode[]
    const safePageName = (page.name || '').trim() || 'Unnamed Page'
    const currentPageName = (figma.currentPage.name || '').trim() || 'Current Page'

    const result: ComponentAuditData[] = []
    const processedComponentSets = new Set<string>()

    // First, process all individual components and identify component sets
    for (const component of components) {
      let componentSetName: string | undefined
      let variantProperties: Record<string, string> | undefined
      let displayName = (component.name || '').trim() || 'Unnamed Component'
      let isVariant = false

      if (component.parent && component.parent.type === 'COMPONENT_SET') {
        const componentSet = component.parent as ComponentSetNode
        componentSetName = (componentSet.name || '').trim() || undefined
        isVariant = true
        
        // Add component set entry if we haven't processed it yet
        if (componentSetName && !processedComponentSets.has(componentSet.id)) {
          processedComponentSets.add(componentSet.id)

          // Set-level DS naming checks: set name casing + property definitions
          const setNamingFindings = checkComponentNaming(componentSet)

          result.push({
            id: componentSet.id || 'unknown-component-set',
            name: componentSetName,
            pageName: safePageName,
            hasDescription: hasDescription(componentSet as any), // ComponentSetNode has same description property
            hasDocumentationLink: hasDocumentationLink(componentSet as any), // ComponentSetNode has same documentationLinks property
            hasUnboundProperties: setNamingFindings.length > 0,
            unboundProperties: setNamingFindings,
            isHiddenFromPublishing: isHiddenFromPublishing(componentSetName),
            isOnCurrentPage: safePageName === currentPageName,
            isComponentSet: true
          })
        }

        const variantString = (component.name || '').trim()
        if (variantString) {
          const properties: Record<string, string> = {}

          const pairs = variantString.split(',')
            .map(pair => pair.trim())
            .filter(pair => pair.length > 0 && pair.includes('='))

          pairs.forEach(pair => {
            const [key, value] = pair.split('=').map(part => part.trim())
            if (key && key.length > 0 && value && value.length > 0) {
              properties[key] = value
            }
          })

          if (Object.keys(properties).length > 0) {
            variantProperties = properties
          }
        }
      }

      const unboundCheck = checkForUnboundProperties(component)
      const misuseFindings = await checkTokenMisuse(component)
      // Standalone components carry their own name/props checks; variants — layer naming
      const namingFindings = isVariant
        ? checkLayerNaming(component)
        : [...checkComponentNaming(component), ...checkLayerNaming(component)]
      const allProperties = [...unboundCheck.properties, ...misuseFindings, ...namingFindings]
      const usedComponents = await collectUsedComponents(component)

      // Add individual component/variant entry
      result.push({
        id: component.id || 'unknown-component',
        name: displayName,
        componentSetName,
        variantProperties,
        pageName: safePageName,
        hasDescription: hasDescription(component),
        hasDocumentationLink: hasDocumentationLink(component),
        hasUnboundProperties: allProperties.length > 0,
        unboundProperties: allProperties,
        isHiddenFromPublishing: isHiddenFromPublishing(componentSetName || displayName),
        isOnCurrentPage: safePageName === currentPageName,
        isVariant,
        usedComponents: usedComponents.length > 0 ? usedComponents : undefined
      })
    }

    // Post-process to determine which component sets should be expandable
    // A component set is expandable if any of its variants have unbound properties
    const componentSetExpandability = new Map<string, boolean>()
    
    const setUsedComponents = new Map<string, Set<string>>()

    result.forEach(component => {
      if (component.isVariant && component.componentSetName) {
        const componentSetEntry = result.find(c => c.isComponentSet && c.name === component.componentSetName)
        if (componentSetEntry) {
          if (component.hasUnboundProperties) {
            componentSetExpandability.set(componentSetEntry.id, true)
          }
          // Union of variant deps → set entry
          if (component.usedComponents) {
            if (!setUsedComponents.has(componentSetEntry.id)) {
              setUsedComponents.set(componentSetEntry.id, new Set())
            }
            const bucket = setUsedComponents.get(componentSetEntry.id)!
            component.usedComponents.forEach(n => bucket.add(n))
          }
        }
      }
    })

    // Update hasExpandableContent for all entries
    return result.map(component => {
      const setUsed = component.isComponentSet ? setUsedComponents.get(component.id) : undefined
      const usedComponents = component.isComponentSet
        ? (setUsed && setUsed.size > 0 ? Array.from(setUsed).sort() : undefined)
        : component.usedComponents
      const hasDeps = !!(usedComponents && usedComponents.length > 0)
      return {
        ...component,
        usedComponents,
        hasExpandableContent: component.isComponentSet
          ? (componentSetExpandability.get(component.id) || component.hasUnboundProperties || hasDeps)
          : (component.hasUnboundProperties || hasDeps)
      }
    })
  }

  const toggleComponentExpansion = (componentId: string) => {
    if (expandedComponents.includes(componentId)) {
      setExpandedComponents(expandedComponents.filter(id => id !== componentId))
    } else {
      setExpandedComponents([...expandedComponents, componentId])
    }
  }

  const filterUnboundPropertiesWithZeroValues = (properties: UnboundProperty[]): UnboundProperty[] => {
    return properties.filter(prop => {
      // Ignored by user — hidden everywhere (counters, rows, component filter)
      if (ignoredFindings.length > 0 && ignoredFindings.indexOf(findingKey(prop)) !== -1) {
        return false
      }

      // Granular filtering based on property type and property name
      let shouldShow = false
      
      switch (prop.type) {
        case 'fill':
          shouldShow = settings.showFillValues
          break
        case 'stroke':
          // Check if it's stroke color or stroke weight
          if (prop.property.includes('Weight')) {
            shouldShow = settings.showStrokeWeightValues
          } else {
            shouldShow = settings.showStrokeColorValues
          }
          break
        case 'text':
          // Check specific text property
          if (prop.property === 'Font Family') {
            shouldShow = settings.showFontFamilyValues
          } else if (prop.property === 'Font Size') {
            shouldShow = settings.showFontSizeValues
          } else if (prop.property === 'Line Height') {
            shouldShow = settings.showLineHeightValues
          } else {
            // Default for any other text properties
            shouldShow = settings.showFontFamilyValues || settings.showFontSizeValues || settings.showLineHeightValues
          }
          break
        case 'spacing':
          // Check specific spacing property
          if (prop.property === 'Padding Top') {
            shouldShow = settings.showPaddingTopValues
          } else if (prop.property === 'Padding Right') {
            shouldShow = settings.showPaddingRightValues
          } else if (prop.property === 'Padding Bottom') {
            shouldShow = settings.showPaddingBottomValues
          } else if (prop.property === 'Padding Left') {
            shouldShow = settings.showPaddingLeftValues
          } else if (prop.property === 'Item Spacing' || prop.property === 'Gap') {
            shouldShow = settings.showItemSpacingValues
          } else {
            // Default for any other spacing properties
            shouldShow = settings.showPaddingTopValues || 
                        settings.showPaddingRightValues || 
                        settings.showPaddingBottomValues || 
                        settings.showPaddingLeftValues || 
                        settings.showItemSpacingValues
          }
          break
        case 'cornerRadius':
          // Check specific corner radius property
          if (prop.property === 'All Corners') {
            shouldShow = settings.showAllCornersValues
          } else if (prop.property === 'Top Left Radius') {
            shouldShow = settings.showTopLeftRadiusValues
          } else if (prop.property === 'Top Right Radius') {
            shouldShow = settings.showTopRightRadiusValues
          } else if (prop.property === 'Bottom Left Radius') {
            shouldShow = settings.showBottomLeftRadiusValues
          } else if (prop.property === 'Bottom Right Radius') {
            shouldShow = settings.showBottomRightRadiusValues
          } else {
            // Default for any other corner radius properties
            shouldShow = settings.showAllCornersValues || 
                        settings.showTopLeftRadiusValues || 
                        settings.showTopRightRadiusValues || 
                        settings.showBottomLeftRadiusValues || 
                        settings.showBottomRightRadiusValues
          }
          break
        case 'effect':
          // Check specific effect property
          if (prop.property.includes('Color')) {
            shouldShow = settings.showEffectColorValues
          } else if (prop.property.includes('Offset') || 
                     prop.property.includes('Blur') || 
                     prop.property.includes('Spread')) {
            shouldShow = settings.showEffectValuesValues
          } else {
            // Effect type - show if any effect setting is on
            shouldShow = settings.showEffectValues || 
                        settings.showEffectColorValues || 
                        settings.showEffectValuesValues
          }
          break
        case 'appearance':
          shouldShow = settings.showAppearanceValues
          break
        case 'tokenMisuse': {
          const ruleKey = prop.ruleId ? DS_RULE_SETTINGS[prop.ruleId] : undefined
          const ruleEnabled = ruleKey ? (settings as any)[ruleKey] !== false : true
          shouldShow = settings.showTokenMisuse && ruleEnabled
          break
        }
        default:
          shouldShow = true
      }
      
      if (!shouldShow) {
        return false
      }
      
      // Filter out zero values if that setting is enabled
      if (settings.hideZeroValues) {
        const value = (prop.currentValue || '').trim().toLowerCase()
        // Check if value is exactly "0" or starts with "0px", "0pt", "0rem", etc.
        if (value === '0' || value.match(/^0(px|pt|rem|em|%|\s)/)) {
          return false
        }
      }
      
      return true
    })
  }

  const shouldShowComponent = (component: ComponentAuditData): boolean => {
    // Check if any filters are active
    const hasActiveFilters = settings.showMissingDescription ||
                             settings.showMissingDocsLink ||
                             settings.showMissingVariables ||
                             settings.showTokenMisuse ||
                             settings.showUsedComponents
    
    // If no filters are active, show nothing
    if (!hasActiveFilters) {
      return false
    }
    
    // When filters are active, component must match at least one active filter
    let matchesFilter = false
    
    if (settings.showMissingDescription && !component.hasDescription) {
      matchesFilter = true
    }
    
    if (settings.showMissingDocsLink && !component.hasDocumentationLink) {
      matchesFilter = true
    }
    
    if (settings.showMissingVariables) {
      if (settings.hideZeroValues) {
        // Check if there are non-zero unbound properties
        const filteredProperties = filterUnboundPropertiesWithZeroValues(component.unboundProperties)
        if (filteredProperties.length > 0) {
          matchesFilter = true
        }
      } else {
        // Check if there are any unbound properties
        if (component.hasUnboundProperties) {
          matchesFilter = true
        }
      }
    }

    if (settings.showTokenMisuse && component.unboundProperties.some(p => p.type === 'tokenMisuse')) {
      matchesFilter = true
    }

    if (settings.showUsedComponents && component.usedComponents && component.usedComponents.length > 0) {
      matchesFilter = true
    }

    return matchesFilter
  }

  const getPageData = (): PageData[] => {
    const pageGroups = auditData.reduce((acc, component) => {
      // Apply filter based on settings
      if (!shouldShowComponent(component)) return acc
      
      if (!acc[component.pageName]) {
        acc[component.pageName] = []
      }
      acc[component.pageName].push(component)
      return acc
    }, {} as Record<string, ComponentAuditData[]>)

    return Object.keys(pageGroups).map(pageName => ({
      pageName,
      components: pageGroups[pageName],
      isExpanded: expandedPages.includes(pageName),
      displayedCount: pageDisplayCounts[pageName] || CHUNK_SIZE
    }))
  }

  const togglePageExpansion = (pageName: string) => {
    if (expandedPages.includes(pageName)) {
      setExpandedPages(expandedPages.filter(p => p !== pageName))
    } else {
      setExpandedPages([...expandedPages, pageName])
      if (!pageDisplayCounts[pageName]) {
        setPageDisplayCounts({
          ...pageDisplayCounts,
          [pageName]: CHUNK_SIZE
        })
      }
    }
  }

const navigateToComponent = async (componentId: string, specificNodeId?: string) => {
  try {
    // Both scan modes stay on the current page — no cross-page loading needed
    // If we have a specific node ID, try to navigate to that node instead
    const targetNodeId = specificNodeId || componentId
    const targetNode = await figma.getNodeByIdAsync(targetNodeId)
    
    if (targetNode && 'x' in targetNode) {
      // Кадр до прыжка — виджет в нём виден, поэтому возврат к нему и есть возврат к виджету
      const prevCenter = { x: figma.viewport.center.x, y: figma.viewport.center.y }
      const prevZoom = figma.viewport.zoom
      const prevSelection = figma.currentPage.selection

      // Select the specific node (only SceneNodes can be selected)
      figma.currentPage.selection = [targetNode as SceneNode]

      // Navigate to the specific node with comfortable zoom
      figma.viewport.scrollAndZoomIntoView([targetNode as SceneNode])

      // Show notification with node name and return instruction
      const nodeName = specificNodeId ? targetNode.name : safeText(targetNode.name)
      figma.notify(`${safeText(nodeName)} • двойной клик по слою виджета — тоже возврат`, {
        timeout: 300000,
        button: {
          text: '← К виджету',
          action: () => {
            figma.viewport.center = prevCenter
            figma.viewport.zoom = prevZoom
            figma.currentPage.selection = prevSelection
          }
        }
      })
    }
  } catch (error) {
    console.error('Error navigating to node:', error)
    figma.notify('Не удалось перейти к узлу')
  }
}

  const resetAll = () => {
    setAuditData([])
    setLastScanTime('')
    setPageProgress([])
    setCurrentProgress('')
    setExpandedPages([])
    setExpandedComponents([])
    setPageDisplayCounts({})
    setIsSettingsExpanded(false)
    setIsIndividualPropsExpanded(false)
    setSettings({
      showMissingDescription: true,
      showMissingDocsLink: true,
      showMissingVariables: true,
      showTokenMisuse: true,
      showUsedComponents: true,
      showRuleSpacingCategory: true,
      showRuleLayoutVocab: true,
      showRuleRegionScope: true,
      showRuleSemanticLayer: true,
      showRuleTierDiscipline: true,
      showRuleComponentTier: true,
      showRuleGradientStops: true,
      showRuleComponentName: true,
    showRuleSubComponentName: true,
      showRulePropCamelCase: true,
      showRuleBooleanPrefix: true,
      showRuleGlossary: true,
      showRuleLayerNaming: true,
      hideZeroValues: true,
      showFillValues: true,
      // Stroke group
      showStrokeColorValues: true,
      showStrokeWeightValues: true,
      // Text group
      showFontFamilyValues: true,
      showFontSizeValues: true,
      showLineHeightValues: true,
      // Spacing group
      showPaddingValues: true,
      showPaddingTopValues: true,
      showPaddingRightValues: true,
      showPaddingBottomValues: true,
      showPaddingLeftValues: true,
      showItemSpacingValues: true,
      // Corner Radius group
      showAllCornersValues: true,
      showTopLeftRadiusValues: true,
      showTopRightRadiusValues: true,
      showBottomLeftRadiusValues: true,
      showBottomRightRadiusValues: true,
      // Effects group
      showEffectValues: true,
      showEffectColorValues: true,
      showEffectValuesValues: true,
      showAppearanceValues: false
    })
  }

  const rescan = async () => {
    if (auditData.length === 0) return
    if (lastScanMode === 'selection') {
      await runScanSelection()
    } else {
      await runDeepScanCurrentPage()
    }
  }

  // Helper function to clean component data for serialization
  const cleanComponentData = (components: ComponentAuditData[]): ComponentAuditData[] => {
    try {
      return components.map((component, index) => {
        try {
          return {
            ...component,
            // Ensure all required properties have values
            id: (component.id || '').trim() || `generated-${index}`,
            name: (component.name || '').trim() || 'Unnamed Component',
            pageName: (component.pageName || '').trim() || 'Unknown Page',
            // Ensure all properties are serializable and have default values
            unboundProperties: component.unboundProperties?.map(prop => ({
              type: prop.type || 'unknown',
              property: (prop.property || '').trim() || 'Unknown Property',
              currentValue: (prop.currentValue || '').trim() || 'N/A',
              nodePath: (prop.nodePath || '').trim() || 'Unknown Path',
              nodeId: (prop.nodeId || '').trim() || undefined,
              ruleId: prop.ruleId || undefined,
              fixRename: prop.fixRename || undefined,
              fixBindVariableId: prop.fixBindVariableId || undefined,
              fixBindName: prop.fixBindName || undefined,
              fixBindField: prop.fixBindField || undefined
            })) || [],
            usedComponents: component.usedComponents && component.usedComponents.length > 0
              ? component.usedComponents.map(n => (n || '').trim()).filter(Boolean)
              : undefined,
            // Ensure other optional properties have proper values
            componentSetName: component.componentSetName ? 
              (component.componentSetName.trim() || undefined) : undefined,
            variantProperties: component.variantProperties ? 
              (() => {
                const cleanedProps: Record<string, string> = {}
                for (const key in component.variantProperties) {
                  const value = component.variantProperties[key]
                  if (key && key.trim() && value && value.trim()) {
                    cleanedProps[key.trim()] = value.trim()
                  }
                }
                return Object.keys(cleanedProps).length > 0 ? cleanedProps : undefined
              })() : undefined
          }
        } catch (componentError) {
          console.error(`Error cleaning component at index ${index}:`, componentError, component)
          // Return a minimal valid component structure
          return {
            id: (component?.id || '').trim() || `error-${index}`,
            name: (component?.name || '').trim() || 'Error Component',
            pageName: (component?.pageName || '').trim() || 'Unknown Page',
            hasDescription: false,
            hasDocumentationLink: false,
            hasUnboundProperties: false,
            unboundProperties: [],
            isHiddenFromPublishing: false,
            isOnCurrentPage: false
          }
        }
      })
    } catch (error) {
      console.error('Error in cleanComponentData:', error)
      return []
    }
  }

  const ProgressIndicator = () => {
    if (!isDeepScanning && pageProgress.length === 0) return null

    // Check if deep scan is complete
    const isDeepScanComplete = currentProgress.includes('Глубокий скан завершён')
    const backgroundColor = isDeepScanComplete ? '#EFFFEC' : '#f5f5f5'
    const textColor = isDeepScanComplete ? '#106A00' : '#222'

    return (
      <AutoLayout direction="vertical" spacing={0} fill={backgroundColor} cornerRadius={16} width="fill-parent">
        {/* Title row - clickable to toggle accordion */}
        <AutoLayout 
          direction="horizontal" 
          spacing={8} 
          padding={12} 
          verticalAlignItems="center" 
          width="fill-parent"
          onClick={() => setIsProgressExpanded(!isProgressExpanded)}
          cornerRadius={16}
        >
          {isProgressExpanded ? (
            <ChevronDownIcon color={textColor} size={16} />
          ) : (
            <ChevronRightIcon color={textColor} size={16} />
          )}
          <Text fontSize={12} fontWeight={600} fill={textColor} width="fill-parent">
            {safeText(currentProgress) !== 'N/A' ? safeText(currentProgress) : 'Обработка…'}
          </Text>
        </AutoLayout>
        
        {isProgressExpanded && (
          <AutoLayout direction="vertical" spacing={4} padding={{ left: 8, right: 12, bottom: 12 }} width="fill-parent">
        {pageProgress.length > 0 && (
              <>
            {(pageProgress || []).map((page, index) => (
              <AutoLayout key={`${safeText(page.name)}-${index}`} direction="horizontal" spacing={8} verticalAlignItems="center" width="fill-parent">
                    <AutoLayout direction="horizontal" spacing={4} verticalAlignItems="center">
                      <AutoLayout width={24} height={24} horizontalAlignItems="center" verticalAlignItems="center">
                        {page.status === 'pending' ? (
                          <Text fontSize={12}>⏳</Text>
                        ) : page.status === 'loading' ? (
                          <Text fontSize={12}>🔄</Text>
                        ) : page.status === 'complete' ? (
                          <CircleCheckIcon color={'#106A00'} />
                        ) : (
                          <XIcon />
                        )}
                      </AutoLayout>
                      <Text fontSize={12} width={150} fill="#106A00">{safeText(page.name)}</Text>
                    </AutoLayout>
                    <Text fontSize={12} fill="#106A00">
                  {page.status === 'complete' ? `${safeText(page.componentCount)} комп.` :
                   page.status === 'loading' ? 'Загрузка…' :
                   page.status === 'error' ? 'Ошибка' : 'Ожидание…'}
                </Text>
              </AutoLayout>
            ))}
              </>
            )}
          </AutoLayout>
        )}
      </AutoLayout>
    )
  }

  const UnboundPropertiesDetail = ({ properties, componentId, isOnCurrentPage, settings }: { 
    properties: UnboundProperty[], 
    componentId: string, 
    isOnCurrentPage: boolean,
    settings: SettingsState
  }) => {
    try {
      if (!properties || properties.length === 0) return null

    // Apply zero value filter
    const filteredProperties = filterUnboundPropertiesWithZeroValues(properties)
    
    if (filteredProperties.length === 0) return null

    const groupedProperties = filteredProperties.reduce((acc, prop) => {
      const safeType = (prop.type || '').trim() || 'unknown'
      if (!acc[safeType]) {
        acc[safeType] = []
      }
      acc[safeType].push(prop)
      return acc
    }, {} as Record<string, UnboundProperty[]>)

    const typeLabels = {
      fill: '🎨 Цвета (Fill)',
      stroke: '🖊️ Обводка',
      text: '📝 Типографика',
      cornerRadius: '📐 Радиус углов',
      spacing: '📏 Отступы',
      effect: '✨ Эффекты',
      appearance: '👁️ Прозрачность',
      tokenMisuse: '🚨 Нарушения правил ДС',
      unknown: '❓ Неизвестный тип'
    }

    return (
      <AutoLayout direction="vertical" spacing={12} width="fill-parent" padding={{ bottom: 12 }}>
        <Text fontSize={12} fontWeight={600} fill="#000">Свойства без переменных/стилей</Text>
        
        {Object.keys(groupedProperties).map((type, typeIndex) => (
          <AutoLayout key={`type-${type}-${typeIndex}`} direction="vertical" spacing={8} width="fill-parent">
            <Text fontSize={11} fontWeight={600} fill="#000">
              {typeLabels[type as keyof typeof typeLabels] || safeText(`Unknown Type (${type})`)}
            </Text>
            <AutoLayout direction="vertical" spacing={8} width="fill-parent">
            {(groupedProperties[type] || []).map((prop, index) => {
              const safeProperty = safeText(prop.property)
              const safeCurrentValue = safeText(prop.currentValue)
              const safeNodePath = safeText(prop.nodePath)
              const targetNodeId = prop.nodeId || componentId  // Use specific node ID if available
              
              return (
                <AutoLayout 
                  key={`${safeText(type)}-${index}-${safeProperty}`} 
                  direction="vertical" 
                  spacing={4} 
                  padding={{ top: 8, right: 16, bottom: 8, left: 16 }} 
                  fill="#FFF2F2" 
                  cornerRadius={8} 
                  stroke="#FFD6D6"
                  width="fill-parent"
                >
                  {/* Навигация — только на иконке-стрелке: клики вложенных кнопок всплывают
                      к родителю, а stopPropagation в Widget API нет. Была на всей строке —
                      «Игнор» / «Привязать» / «Исправить» уводили вьюпорт к узлу. */}
                  <AutoLayout direction="horizontal" spacing={8} width="fill-parent" verticalAlignItems="center">
                    <AutoLayout direction="vertical" spacing={4} width="fill-parent">
                      <AutoLayout direction="horizontal" spacing={8} width="fill-parent">
                        <Text fontSize={11} fill="#6A0000" width={110}>{safeProperty}:</Text>
                        <Text fontSize={11} fill="#6A0000" width="fill-parent">{safeCurrentValue}</Text>
                      </AutoLayout>
                      {prop.fixBindName && (
                        <Text fontSize={10} fill="#7A3E00" width="fill-parent">
                          {prop.type === 'tokenMisuse'
                            ? `→ семантическая замена с тем же значением: ${prop.fixBindName}`
                            : `→ есть токен с этим значением: ${prop.fixBindName}`}
                        </Text>
                      )}
                    </AutoLayout>
                    {prop.fixBindName && (
                      <AutoLayout
                        padding={{ vertical: 3, horizontal: 7 }}
                        fill="#FFE2C4"
                        stroke="#E8A968"
                        strokeWidth={1}
                        cornerRadius={6}
                        onClick={() => applyFixBind(componentId, prop)}
                        hoverStyle={{ fill: "#FFD199" }}
                      >
                        <Text fontSize={10} fill="#7A3E00" fontWeight={600}>Привязать</Text>
                      </AutoLayout>
                    )}
                    {prop.fixRename && (
                      <AutoLayout
                        padding={{ vertical: 3, horizontal: 7 }}
                        fill="#FFE2C4"
                        stroke="#E8A968"
                        strokeWidth={1}
                        cornerRadius={6}
                        onClick={() => applyFixRename(componentId, prop)}
                        hoverStyle={{ fill: "#FFD199" }}
                      >
                        <Text fontSize={10} fill="#7A3E00" fontWeight={600}>Исправить</Text>
                      </AutoLayout>
                    )}
                    <AutoLayout
                      padding={{ vertical: 3, horizontal: 7 }}
                      fill="#EFEFEF"
                      stroke="#D5D5D5"
                      strokeWidth={1}
                      cornerRadius={6}
                      onClick={() => toggleIgnoreFinding(prop)}
                      hoverStyle={{ fill: "#E0E0E0" }}
                    >
                      <Text fontSize={10} fill="#555555" fontWeight={600}>Игнор</Text>
                    </AutoLayout>
                    {isOnCurrentPage && (
                      <AutoLayout
                        width={24}
                        height={24}
                        cornerRadius={6}
                        horizontalAlignItems="center"
                        verticalAlignItems="center"
                        onClick={() => navigateToComponent(componentId, targetNodeId)}
                        hoverStyle={{ fill: "#FFE5E5", stroke: "#FFC1C1" }}
                      >
                        <ExternalLinkIcon color="#6A0000" size={12} />
                      </AutoLayout>
                    )}
                  </AutoLayout>
                </AutoLayout>
              )
            })}
            </AutoLayout>
          </AutoLayout>
        ))}
      </AutoLayout>
    )
    } catch (error) {
      console.error('Error in UnboundPropertiesDetail:', error)
      return (
        <AutoLayout direction="vertical" spacing={8} padding={8} fill="#FFEBEE" cornerRadius={4} width="fill-parent">
          <Text fontSize={11} fill="#C62828">Ошибка отображения свойств</Text>
      </AutoLayout>
    )
    }
  }

const SettingsPanel = ({
  settings,
  setSettings,
  isIndividualPropsExpanded,
  setIsIndividualPropsExpanded,
  ignoredCount,
  onResetIgnores
}: {
  settings: SettingsState,
  setSettings: (settings: SettingsState) => void,
  isIndividualPropsExpanded: boolean,
  setIsIndividualPropsExpanded: (value: boolean) => void,
  ignoredCount: number,
  onResetIgnores: () => void
}) => {
  const toggleSetting = (key: keyof SettingsState) => {
    const newValue = !settings[key]
    const newSettings = { ...settings }
    
    // Handle hierarchical relationships for grouped settings
    
    // Stroke group - first checkbox acts as "toggle all"
    if (key === 'showStrokeColorValues') {
      // Parent: toggle all children in stroke group
      newSettings.showStrokeColorValues = newValue
      newSettings.showStrokeWeightValues = newValue
    } else if (key === 'showStrokeWeightValues') {
      // Child affects parent
      newSettings.showStrokeWeightValues = newValue
      if (!newValue) {
        newSettings.showStrokeColorValues = false
      } else {
        // Turn on parent only if all siblings are on
        newSettings.showStrokeColorValues = newSettings.showStrokeColorValues && newValue
      }
    }
    // Text group - first checkbox acts as "toggle all"
    else if (key === 'showFontFamilyValues') {
      // Parent: toggle all children in text group
      newSettings.showFontFamilyValues = newValue
      newSettings.showFontSizeValues = newValue
      newSettings.showLineHeightValues = newValue
    } else if (['showFontSizeValues', 'showLineHeightValues'].includes(key)) {
      // Child affects parent
      newSettings[key] = newValue
      if (!newValue) {
        newSettings.showFontFamilyValues = false
      } else {
        // Turn on parent only if all siblings are on
        const allTextOn = newSettings.showFontFamilyValues && 
                         newSettings.showFontSizeValues && 
                         newSettings.showLineHeightValues
        newSettings.showFontFamilyValues = allTextOn
      }
    }
    // Spacing group - "Auto layout" is parent of both spacing AND padding directions
    else if (key === 'showPaddingValues') {
      // Parent: toggle all children (spacing + padding directions)
      newSettings.showPaddingValues = newValue
      newSettings.showItemSpacingValues = newValue
      newSettings.showPaddingTopValues = newValue
      newSettings.showPaddingRightValues = newValue
      newSettings.showPaddingBottomValues = newValue
      newSettings.showPaddingLeftValues = newValue
    } else if (['showItemSpacingValues', 'showPaddingTopValues', 'showPaddingRightValues', 'showPaddingBottomValues', 'showPaddingLeftValues'].includes(key)) {
      // Child: update self and parent
      newSettings[key] = newValue
      // If turning off, turn off parent. If turning on, check if all siblings are on
      if (!newValue) {
        newSettings.showPaddingValues = false
      } else {
        const allSpacingOn = newSettings.showItemSpacingValues &&
                            newSettings.showPaddingTopValues && 
                            newSettings.showPaddingRightValues && 
                            newSettings.showPaddingBottomValues && 
                            newSettings.showPaddingLeftValues
        newSettings.showPaddingValues = allSpacingOn
      }
    }
    // Corner Radius group
    else if (key === 'showAllCornersValues') {
      // Parent: toggle all children
      newSettings.showAllCornersValues = newValue
      newSettings.showTopLeftRadiusValues = newValue
      newSettings.showTopRightRadiusValues = newValue
      newSettings.showBottomLeftRadiusValues = newValue
      newSettings.showBottomRightRadiusValues = newValue
    } else if (['showTopLeftRadiusValues', 'showTopRightRadiusValues', 'showBottomLeftRadiusValues', 'showBottomRightRadiusValues'].includes(key)) {
      // Child: update self and parent
      newSettings[key] = newValue
      // If turning off, turn off parent. If turning on, check if all siblings are on
      if (!newValue) {
        newSettings.showAllCornersValues = false
      } else {
        const allCornersOn = newSettings.showTopLeftRadiusValues && 
                            newSettings.showTopRightRadiusValues && 
                            newSettings.showBottomLeftRadiusValues && 
                            newSettings.showBottomRightRadiusValues
        newSettings.showAllCornersValues = allCornersOn
      }
    }
    // Effects group
    else if (key === 'showEffectValues') {
      // Parent: toggle all children
      newSettings.showEffectValues = newValue
      newSettings.showEffectColorValues = newValue
      newSettings.showEffectValuesValues = newValue
    } else if (['showEffectColorValues', 'showEffectValuesValues'].includes(key)) {
      // Child: update self and parent
      newSettings[key] = newValue
      // If turning off, turn off parent. If turning on, check if all siblings are on
      if (!newValue) {
        newSettings.showEffectValues = false
      } else {
        const allEffectsOn = newSettings.showEffectColorValues && 
                            newSettings.showEffectValuesValues
        newSettings.showEffectValues = allEffectsOn
      }
    } else {
      // No hierarchy, just toggle
      newSettings[key] = newValue
    }
    
    setSettings(newSettings)
  }
  
  // Helper component for simple checkboxes
  const SimpleCheckbox = ({ 
    checked, 
    label, 
    onClick,
    isFirst = false,
    isLast = false
  }: { 
    checked: boolean, 
    label: string, 
    onClick: () => void,
    isFirst?: boolean,
    isLast?: boolean
  }) => {
    // Calculate corner radius based on position
    let cornerRadius: number | { topLeft: number, topRight: number, bottomLeft: number, bottomRight: number }
    if (isFirst && isLast) {
      // Single item - all corners rounded
      cornerRadius = 10
    } else if (isFirst) {
      // First item - left corners rounded
      cornerRadius = { topLeft: 10, topRight: 0, bottomLeft: 10, bottomRight: 0 }
    } else if (isLast) {
      // Last item - right corners rounded
      cornerRadius = { topLeft: 0, topRight: 10, bottomLeft: 0, bottomRight: 10 }
    } else {
      // Middle item - no corners rounded
      cornerRadius = 0
    }
    
    // Determine fill color based on checked state and position
    let fillColor: string
    if (checked) {
      fillColor = "#E6FDE2" // Light green when checked
    } else if (isFirst) {
      fillColor = "#FFFFFF" // White for first item when unchecked
    } else {
      fillColor = "#F5F5F5" // Light gray for other items when unchecked
    }
    
    return (
      <AutoLayout 
        direction="horizontal" 
        spacing={4} 
        onClick={onClick}
        verticalAlignItems="center"
        padding={{ top: 4, left: 6, bottom: 4, right: 6 }}
        cornerRadius={cornerRadius}
        fill={fillColor}
        stroke="#fff"
        strokeWidth={1}
        height={32}
      >
      <AutoLayout 
        width={14} 
        height={14} 
        horizontalAlignItems="center" 
        verticalAlignItems="center"
      >
        {checked ? (
          <CircleCheckIcon size={14} color="#18A700" />
        ) : (
          <Rectangle 
            width={12} 
            height={12} 
            stroke="#999999" 
            strokeWidth={1} 
            cornerRadius={2}
            fill="#FFFFFF"
          />
        )}
      </AutoLayout>
      <Text fontSize={11} fill={checked ? "#106A00" : "#333333"} fontWeight={500}>{label}</Text>
    </AutoLayout>
    )
  }

  return (
    <AutoLayout direction="vertical" spacing={8} padding={{ left: 8, right: 12, top: 0, bottom: 12 }} width="fill-parent">
      {/* Top-level checkboxes */}
      <AutoLayout direction="horizontal" spacing={2} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
        <SimpleCheckbox
          checked={settings.showMissingDescription}
          label="Описание компонента"
          onClick={() => toggleSetting('showMissingDescription')}
          isFirst={true}
        />
        <SimpleCheckbox
          checked={settings.showMissingDocsLink}
          label="Ссылка на документацию"
          onClick={() => toggleSetting('showMissingDocsLink')}
        />
        <SimpleCheckbox
          checked={settings.showMissingVariables}
          label="Переменные"
          onClick={() => toggleSetting('showMissingVariables')}
        />
        <SimpleCheckbox
          checked={settings.showTokenMisuse}
          label="Правила ДС"
          onClick={() => toggleSetting('showTokenMisuse')}
        />
        <SimpleCheckbox
          checked={settings.showUsedComponents !== false}
          label="Используемые компоненты"
          onClick={() => toggleSetting('showUsedComponents')}
          isLast={true}
        />
      </AutoLayout>

      {ignoredCount > 0 && (
        <AutoLayout
          padding={{ vertical: 4, horizontal: 8 }}
          fill="#EFEFEF"
          stroke="#D5D5D5"
          strokeWidth={1}
          cornerRadius={8}
          onClick={onResetIgnores}
          hoverStyle={{ fill: "#E0E0E0" }}
          width="hug-contents"
        >
          <Text fontSize={10} fill="#555555" fontWeight={600}>{`Сбросить игноры (${safeText(ignoredCount)})`}</Text>
        </AutoLayout>
      )}
      
      {/* Individual properties collapsible section */}
      <AutoLayout direction="vertical" spacing={8} width="fill-parent">
        {/* Collapsible header */}
        <AutoLayout 
          direction="horizontal" 
          spacing={6} 
          onClick={() => setIsIndividualPropsExpanded(!isIndividualPropsExpanded)}
          verticalAlignItems="center"
        >
          {isIndividualPropsExpanded ? (
            <ChevronDownIcon color="#333333" size={12} />
          ) : (
            <ChevronRightIcon color="#333333" size={12} />
          )}
          <Text fontSize={11} fontWeight={600} fill="#333333">Отдельные свойства</Text>
        </AutoLayout>
        
        {isIndividualPropsExpanded && (
          <AutoLayout direction="vertical" spacing={8} width="hug-contents">
            {/* Fill, Opacity, Ignore "0" values */}
            <AutoLayout direction="horizontal" spacing={4} wrap={true} width="hug-contents">
              <AutoLayout direction="horizontal" spacing={1} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
                <SimpleCheckbox checked={settings.showFillValues} label="Заливка" onClick={() => toggleSetting('showFillValues')} isFirst={true} isLast={true} />
              </AutoLayout>

              <AutoLayout direction="horizontal" spacing={1} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
                <SimpleCheckbox checked={settings.showAppearanceValues} label="Прозрачность" onClick={() => toggleSetting('showAppearanceValues')} isFirst={true} isLast={true} />
              </AutoLayout>

              <AutoLayout direction="horizontal" spacing={1} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
                <SimpleCheckbox
                  checked={settings.hideZeroValues}
                  label="Игнорировать «0»"
                  onClick={() => toggleSetting('hideZeroValues')}
                  isFirst={true}
                  isLast={true}
                />
              </AutoLayout>
            </AutoLayout>
            
            {/* Stroke group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showStrokeColorValues} label="Обводка" onClick={() => toggleSetting('showStrokeColorValues')} isFirst={true} />
              <SimpleCheckbox checked={settings.showStrokeColorValues} label="Цвет обводки" onClick={() => toggleSetting('showStrokeColorValues')} />
              <SimpleCheckbox checked={settings.showStrokeWeightValues} label="Толщина" onClick={() => toggleSetting('showStrokeWeightValues')} isLast={true} />
            </AutoLayout>
            
            {/* Text group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showFontFamilyValues} label="Текст" onClick={() => toggleSetting('showFontFamilyValues')} isFirst={true} />
              <SimpleCheckbox checked={settings.showFontFamilyValues} label="Шрифт" onClick={() => toggleSetting('showFontFamilyValues')} />
              <SimpleCheckbox checked={settings.showFontSizeValues} label="Кегль" onClick={() => toggleSetting('showFontSizeValues')} />
              <SimpleCheckbox checked={settings.showLineHeightValues} label="Интерлиньяж" onClick={() => toggleSetting('showLineHeightValues')} />
              <SimpleCheckbox checked={settings.showLineHeightValues} label="Трекинг" onClick={() => toggleSetting('showLineHeightValues')} />
              <SimpleCheckbox checked={settings.showLineHeightValues} label="Отступ абзаца" onClick={() => toggleSetting('showLineHeightValues')} isLast={true} />
            </AutoLayout>
            
            {/* Auto layout / Spacing group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showPaddingValues} label="Auto layout" onClick={() => toggleSetting('showPaddingValues')} isFirst={true} />
              <SimpleCheckbox checked={settings.showItemSpacingValues} label="Gap" onClick={() => toggleSetting('showItemSpacingValues')} />
              <SimpleCheckbox checked={settings.showPaddingTopValues} label="Сверху" onClick={() => toggleSetting('showPaddingTopValues')} />
              <SimpleCheckbox checked={settings.showPaddingRightValues} label="Справа" onClick={() => toggleSetting('showPaddingRightValues')} />
              <SimpleCheckbox checked={settings.showPaddingBottomValues} label="Снизу" onClick={() => toggleSetting('showPaddingBottomValues')} />
              <SimpleCheckbox checked={settings.showPaddingLeftValues} label="Слева" onClick={() => toggleSetting('showPaddingLeftValues')} isLast={true} />
            </AutoLayout>
            
            {/* Corner radius group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showAllCornersValues} label="Радиус углов" onClick={() => toggleSetting('showAllCornersValues')} isFirst={true} />
              <SimpleCheckbox checked={settings.showTopLeftRadiusValues} label="Верх-лево" onClick={() => toggleSetting('showTopLeftRadiusValues')} />
              <SimpleCheckbox checked={settings.showTopRightRadiusValues} label="Верх-право" onClick={() => toggleSetting('showTopRightRadiusValues')} />
              <SimpleCheckbox checked={settings.showBottomLeftRadiusValues} label="Низ-лево" onClick={() => toggleSetting('showBottomLeftRadiusValues')} />
              <SimpleCheckbox checked={settings.showBottomRightRadiusValues} label="Низ-право" onClick={() => toggleSetting('showBottomRightRadiusValues')} isLast={true} />
            </AutoLayout>
            
            {/* Effects group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showEffectValues} label="Эффекты" onClick={() => toggleSetting('showEffectValues')} isFirst={true} />
              <SimpleCheckbox checked={settings.showEffectColorValues} label="Цвет эффекта" onClick={() => toggleSetting('showEffectColorValues')} />
              <SimpleCheckbox checked={settings.showEffectValuesValues} label="Параметры эффекта" onClick={() => toggleSetting('showEffectValuesValues')} isLast={true} />
            </AutoLayout>

            {/* DS rules group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showTokenMisuse} label="Правила ДС" onClick={() => toggleSetting('showTokenMisuse')} isFirst={true} />
              <SimpleCheckbox checked={settings.showRuleSpacingCategory !== false} label="Категория отступа" onClick={() => toggleSetting('showRuleSpacingCategory')} />
              <SimpleCheckbox checked={settings.showRuleLayoutVocab !== false} label="Словарь layout/" onClick={() => toggleSetting('showRuleLayoutVocab')} />
              <SimpleCheckbox checked={settings.showRuleRegionScope !== false} label="layout/page внутри" onClick={() => toggleSetting('showRuleRegionScope')} />
              <SimpleCheckbox checked={settings.showRuleSemanticLayer !== false} label="Слой semantic" onClick={() => toggleSetting('showRuleSemanticLayer')} />
              <SimpleCheckbox checked={settings.showRuleTierDiscipline !== false} label="Примитивы" onClick={() => toggleSetting('showRuleTierDiscipline')} />
              <SimpleCheckbox checked={settings.showRuleComponentTier !== false} label="Component-tier" onClick={() => toggleSetting('showRuleComponentTier')} />
              <SimpleCheckbox checked={settings.showRuleGradientStops !== false} label="Стопы градиентов" onClick={() => toggleSetting('showRuleGradientStops')} isLast={true} />
            </AutoLayout>

            {/* DS naming rules group */}
            <AutoLayout direction="horizontal" spacing={1} wrap={true} fill={"#F5F5F5"} stroke="#eee" strokeWidth={1} cornerRadius={12} padding={2} width="hug-contents">
              <SimpleCheckbox checked={settings.showRuleComponentName !== false} label="Имя компонента" onClick={() => toggleSetting('showRuleComponentName')} isFirst={true} />
              <SimpleCheckbox checked={settings.showRuleSubComponentName !== false} label="Имя субкомпонента" onClick={() => toggleSetting('showRuleSubComponentName')} />
              <SimpleCheckbox checked={settings.showRulePropCamelCase !== false} label="camelCase свойств" onClick={() => toggleSetting('showRulePropCamelCase')} />
              <SimpleCheckbox checked={settings.showRuleBooleanPrefix !== false} label="is*/has*" onClick={() => toggleSetting('showRuleBooleanPrefix')} />
              <SimpleCheckbox checked={settings.showRuleGlossary !== false} label="Глоссарий осей" onClick={() => toggleSetting('showRuleGlossary')} />
              <SimpleCheckbox checked={settings.showRuleLayerNaming !== false} label="Имена слоёв" onClick={() => toggleSetting('showRuleLayerNaming')} isLast={true} />
            </AutoLayout>
          </AutoLayout>
        )}
      </AutoLayout>
    </AutoLayout>
  )
}

const ComponentTable = ({ components, displayedCount, settings }: { 
  components: ComponentAuditData[], 
  displayedCount: number,
  settings: SettingsState
}) => {
  
  // Filter and validate components before rendering
  const validComponents = (components || []).filter(component => 
    component && 
    component.id && 
    component.id.trim() && 
    component.name && 
    component.name.trim()
  )
  
  // Use filtered components 
  const visibleComponents = validComponents.slice(0, displayedCount)

  return (
      <AutoLayout direction="vertical" width="fill-parent" stroke="#eee" strokeWidth={1}>

        <AutoLayout direction="horizontal" spacing={0} padding={{ vertical: 8, horizontal: 12 }} width="fill-parent" stroke="#eee" strokeWidth={1}>
          <AutoLayout width={260}><Text fontSize={11} fontWeight={600}>Компонент</Text></AutoLayout>
          <AutoLayout width={70} horizontalAlignItems="center"><Text fontSize={11} fontWeight={600} horizontalAlignText="center">Описание</Text></AutoLayout>
          <AutoLayout width={70} horizontalAlignItems="center"><Text fontSize={11} fontWeight={600} horizontalAlignText="center">Ссылка</Text></AutoLayout>
          <AutoLayout width={70} horizontalAlignItems="center"><Text fontSize={11} fontWeight={600} horizontalAlignText="center">Переменные</Text></AutoLayout>
          <AutoLayout width={24} horizontalAlignItems="center"><Text fontSize={11} fontWeight={600} horizontalAlignText="center">&nbsp;</Text></AutoLayout>
        </AutoLayout>
      
      {visibleComponents.map((component, index) => {
        const isExpanded = expandedComponents.includes(component.id)
        
        // Complete safety for all component properties
        const safeComponent = {
          id: (component.id || '').trim() || `component-${index}`,
          name: (component.name || '').trim() || 'Unnamed Component',
          componentSetName: component.componentSetName ? 
            (component.componentSetName.trim() || undefined) : undefined,
          pageName: (component.pageName || '').trim() || 'Unknown Page',
                      hasDescription: Boolean(component.hasDescription),
            hasDocumentationLink: Boolean(component.hasDocumentationLink),
            hasUnboundProperties: Boolean(component.hasUnboundProperties),
            unboundProperties: component.unboundProperties || [],
            isHiddenFromPublishing: Boolean(component.isHiddenFromPublishing),
            isOnCurrentPage: Boolean(component.isOnCurrentPage),
            isComponentSet: Boolean(component.isComponentSet),
            isVariant: Boolean(component.isVariant),
            hasExpandableContent: Boolean(component.hasExpandableContent),
            usedComponents: component.usedComponents && component.usedComponents.length > 0
              ? component.usedComponents
              : undefined,
          // Clean variant properties completely
          variantProperties: component.variantProperties ? (() => {
            const cleaned: Record<string, string> = {}
            for (const key in component.variantProperties) {
              const value = component.variantProperties[key]
              const cleanKey = (key || '').trim()
              const cleanValue = (value || '').trim()
              if (cleanKey && cleanValue) {
                cleaned[cleanKey] = cleanValue
              }
            }
            return Object.keys(cleaned).length > 0 ? cleaned : undefined
          })() : undefined
        }
          

          
          try {            
            return (
            <AutoLayout key={safeComponent.id} direction="vertical" spacing={0} width="fill-parent">
              <AutoLayout
                direction="horizontal" 
                spacing={0} 
                padding={{ 
                  top: 8, 
                  right: 8, 
                  bottom: 8, 
                  left: safeComponent.isVariant ? 34 : 12
                }} 
                fill={index % 2 === 0 ? "#FFFFFF" : "#FAFAFA"} 
                width="fill-parent"
                hoverStyle={{ fill: "#E3F2FD" }}
                verticalAlignItems="center"
              >
                <AutoLayout width={safeComponent.isVariant ? 238 : 260} direction="horizontal" spacing={8} verticalAlignItems="center">
                  {(() => {
                    // Check if there are any properties after filtering
                    const filteredProps = filterUnboundPropertiesWithZeroValues(safeComponent.unboundProperties)
                    const hasContentToShow = filteredProps.length > 0
                    
                    return hasContentToShow && safeComponent.hasExpandableContent && (
                      <AutoLayout 
                        width={16} 
                        height={16} 
                        horizontalAlignItems="center" 
                        verticalAlignItems="center"
                        onClick={() => toggleComponentExpansion(safeComponent.id)}
                        hoverStyle={{ fill: "#eee" }}
                        cornerRadius={2}
                      >
                        {isExpanded ? (
                          <ChevronDownIcon color="#333333" size={10} />
                        ) : (
                          <ChevronRightIcon color="#333333" size={10} />
                        )}
                      </AutoLayout>
                    )
                  })()}
                  
                  <AutoLayout 
                    direction="vertical" 
                    spacing={2} 
                    width="fill-parent"
                    onClick={safeComponent.isOnCurrentPage ? () => navigateToComponent(safeComponent.id) : undefined}
                    hoverStyle={safeComponent.isOnCurrentPage ? { opacity: 0.8 } : undefined}
                  >
                    {safeComponent.componentSetName ? (
                      <>
                        <AutoLayout direction="horizontal" spacing={6} verticalAlignItems="center" width="fill-parent">
                          {!safeComponent.isVariant && (
                            safeComponent.isComponentSet ? (
                              <ComponentSetIcon color={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} size={12} />
                            ) : (
                              <ComponentIcon color={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} size={12} />
                            )
                          )}
                          <Text fontSize={11} fill={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} fontWeight={600} width="fill-parent">
                            {safeText(safeComponent.componentSetName)}
                          </Text>
                        </AutoLayout>
                        {safeComponent.variantProperties && (
                          <AutoLayout direction="vertical" spacing={1}>
                            {Object.keys(safeComponent.variantProperties).map(key => {
                              const value = safeComponent.variantProperties![key]
                              const displayText = `${safeText(key)}: ${safeText(value)}`
                              return (
                                <Text key={`${safeText(key)}-${safeText(value)}`} fontSize={10} fill="#333333">
                                  {displayText}
                                </Text>
                              )
                            })}
                          </AutoLayout>
                        )}
                        {safeComponent.isHiddenFromPublishing && (
                          <Text fontSize={9} fill="#222">Скрыт из публикации</Text>
                        )}
                      </>
                    ) : (
                      <>
                        <AutoLayout direction="horizontal" spacing={6} verticalAlignItems="center" width="fill-parent">
                          {!safeComponent.isVariant && (
                            safeComponent.isComponentSet ? (
                              <ComponentSetIcon color={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} size={12} />
                            ) : (
                              <ComponentIcon color={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} size={12} />
                            )
                          )}
                          <Text fontSize={11} fill={safeComponent.isOnCurrentPage ? "#1976D2" : "#000000"} fontWeight={600} width="fill-parent">
                            {safeText(safeComponent.name)}
                          </Text>
                        </AutoLayout>
                        {safeComponent.isHiddenFromPublishing && (
                          <Text fontSize={9} fill="#222">Скрыт из публикации</Text>
                        )}
                      </>
                    )}
                  </AutoLayout>
                </AutoLayout>
                
                <AutoLayout horizontalAlignItems="center" verticalAlignItems="center" height={24} width={70}>
                  {safeComponent.hasDescription ? (
                    <CircleCheckIcon />
                  ) : (
                    <XIcon />
                  )}
                </AutoLayout>
                
                <AutoLayout horizontalAlignItems="center" verticalAlignItems="center" height={24} width={70}>
                  {safeComponent.hasDocumentationLink ? (
                    <CircleCheckIcon />
                  ) : (
                    <XIcon />
                  )}
                </AutoLayout>
                
                <AutoLayout horizontalAlignItems="center" verticalAlignItems="center" height={24} width={70}>
                  <AutoLayout direction="horizontal" spacing={4} verticalAlignItems="center">
                    {(() => {
                      const filteredCount = filterUnboundPropertiesWithZeroValues(safeComponent.unboundProperties).length
                      const hasFilteredProps = filteredCount > 0
                      return (
                        <>
                          {hasFilteredProps ? (
                            <XIcon />
                          ) : (
                            <CircleCheckIcon />
                          )}
                          {hasFilteredProps && (
                            <Text fontSize={10} fill="#F44336" fontWeight={600}>
                              {safeText(filteredCount)}
                            </Text>
                          )}
                        </>
                      )
                    })()}
                  </AutoLayout>
                </AutoLayout>
                
                {safeComponent.isOnCurrentPage && (
                  <AutoLayout 
                    horizontalAlignItems="center" 
                    verticalAlignItems="center" 
                    width={24}
                    height={24}
                    onClick={() => navigateToComponent(safeComponent.id)}
                    hoverStyle={{ fill: "#F0F0F0" }}
                    cornerRadius={16}
                  >
                    <ExternalLinkIcon size={12} />
                  </AutoLayout>
                )}
              </AutoLayout>
              
              {isExpanded && settings.showUsedComponents !== false &&
               safeComponent.usedComponents && safeComponent.usedComponents.length > 0 && (
                <AutoLayout
                  direction="vertical"
                  spacing={6}
                  padding={{ vertical: 8, horizontal: 12 }}
                  fill={index % 2 === 0 ? "#FFFFFF" : "#FAFAFA"}
                  width="fill-parent"
                >
                  <Text fontSize={12} fontWeight={600} fill="#000">
                    {`📦 Используемые компоненты (${safeText(safeComponent.usedComponents.length)})`}
                  </Text>
                  <AutoLayout direction="vertical" spacing={4} padding={{ top: 2, right: 12, bottom: 8, left: 12 }} fill="#F0F8FF" cornerRadius={8} width="fill-parent">
                    {safeComponent.usedComponents.map((depName, depIndex) => (
                      <Text key={`dep-${depIndex}`} fontSize={11} fill="#0C4990">{`• ${safeText(depName)}`}</Text>
                    ))}
                  </AutoLayout>
                </AutoLayout>
              )}

              {isExpanded && safeComponent.hasUnboundProperties && (() => {
                // Check if there are any properties after filtering
                const filteredProps = filterUnboundPropertiesWithZeroValues(safeComponent.unboundProperties)
                
                // Only render the container if there are filtered properties
                if (filteredProps.length === 0) return null
                
                return (
                  <AutoLayout 
                    direction="vertical" 
                    spacing={0} 
                    padding={{ vertical: 0, horizontal: 12 }}
                    fill={index % 2 === 0 ? "#FFFFFF" : "#FAFAFA"}
                    width="fill-parent"
                  >
                    <UnboundPropertiesDetail 
                      properties={safeComponent.unboundProperties} 
                      componentId={safeComponent.id}
                      isOnCurrentPage={safeComponent.isOnCurrentPage}
                      settings={settings}
                    />
                  </AutoLayout>
                )
              })()}
            </AutoLayout>
          )
          } catch (error) {
            console.error('Error rendering component:', safeComponent?.id || 'unknown', error)
            return (
              <AutoLayout key={`error-${index}`} direction="vertical" spacing={4} padding={8} fill="#FFEBEE" cornerRadius={4} width="fill-parent">
                <Text fontSize={11} fill="#C62828">Ошибка отображения компонента: {safeText(safeComponent?.name)}</Text>
              </AutoLayout>
            )
          }
        })}
    </AutoLayout>
  )
}

const PageAccordion = ({ pageData }: { pageData: PageData }) => {
  const componentSets = new Set()
  const regularComponents = new Set()
  
  pageData.components.forEach(component => {
    if (component.componentSetName) {
      const safeName = safeText(component.componentSetName)
      if (safeName !== 'N/A') {
        componentSets.add(safeName)
      }
    } else {
      const safeName = safeText(component.name)
      if (safeName !== 'N/A') {
        regularComponents.add(safeName)
      }
    }
  })

  const totalUniqueComponents = componentSets.size + regularComponents.size

  const stats = {
    total: pageData.components.length,
    unique: totalUniqueComponents,
    withDescription: pageData.components.filter(c => c.hasDescription).length,
    withDocumentationLink: pageData.components.filter(c => c.hasDocumentationLink).length,
    withUnboundProperties: pageData.components.filter(c => c.hasUnboundProperties).length,
      hidden: pageData.components.filter(c => c.isHiddenFromPublishing).length
  }

  return (
      <AutoLayout direction="vertical" spacing={0} width="fill-parent" stroke="#eee" cornerRadius={16}>
      <AutoLayout
        direction="horizontal"
          spacing={8}
        padding={12}
          fill="#f5f5f5"
        width="fill-parent"
        verticalAlignItems="center"
        onClick={() => togglePageExpansion(pageData.pageName)}
      >
                  {pageData.isExpanded ? (
          <ChevronDownIcon color="#333333" size={14} />
        ) : (
          <ChevronRightIcon color="#333333" size={14} />
        )}
        <AutoLayout direction="vertical" spacing={2} width="fill-parent">
            <Text fontSize={11} fontWeight={700}>
              {safeText(pageData.pageName)}
            </Text>
          <AutoLayout direction="horizontal" spacing={12}>
              <Text fontSize={11} fill="#333333">
                {`${safeText(stats.total)} вариант(ов) (${safeText(stats.unique)} комп.)`}
            </Text>
            </AutoLayout>
            <AutoLayout direction="horizontal" spacing={12}>
              <Text fontSize={11} fill="#000" fontWeight={400}>{`Описание: ${safeText(stats.withDescription)}`}</Text>
              <Text fontSize={11} fill="#000" fontWeight={400}>{`Ссылка: ${safeText(stats.withDocumentationLink)}`}</Text>
              <Text fontSize={11} fill="#000" fontWeight={400}>{`Без переменных: ${safeText(stats.withUnboundProperties)}`}</Text>
              <Text fontSize={11} fill="#000" fontWeight={400}>{`Скрыто: ${safeText(stats.hidden)}`}</Text>
          </AutoLayout>
        </AutoLayout>
      </AutoLayout>
      {pageData.isExpanded && (
          <AutoLayout direction="vertical" spacing={0} width="fill-parent">
          <ComponentTable 
            components={pageData.components} 
            displayedCount={pageData.displayedCount}
            settings={settings}
          />
        </AutoLayout>
      )}
    </AutoLayout>
  )
}

  const toggleAllPages = (expand: boolean) => {
    if (expand) {
      const allPageNames = getPageData().map(p => p.pageName)
      setExpandedPages(allPageNames)
      
      const newDisplayCounts: Record<string, number> = {}
      allPageNames.forEach(pageName => {
        newDisplayCounts[pageName] = CHUNK_SIZE
      })
      setPageDisplayCounts({ ...pageDisplayCounts, ...newDisplayCounts })
    } else {
      setExpandedPages([])
    }
  }

  const LoadAllButton = ({ pageName, totalCount }: { pageName: string, totalCount: number }) => {
    const currentCount = pageDisplayCounts[pageName] || CHUNK_SIZE
    const remaining = totalCount - currentCount
    
    if (totalCount <= CHUNK_SIZE) return null
    
    return (
      <AutoLayout direction="horizontal" spacing={8} verticalAlignItems="center">
        {/* Load more button - show when there are items remaining */}
        {currentCount < totalCount && (
          <AutoLayout 
            fill="#FAECFF"
            cornerRadius={8} 
            padding={{ vertical: 4, horizontal: 8 }} 
            onClick={() => setPageDisplayCounts({
              ...pageDisplayCounts,
              [pageName]: currentCount + LOAD_MORE_SIZE
            })}
            hoverStyle={{ fill: "#EFC8FD" }}
          >
            <Text fontSize={10} fill="#8C00BA">{`Показать ещё ${safeText(Math.min(LOAD_MORE_SIZE, remaining))} (осталось ${safeText(remaining)})`}</Text>
          </AutoLayout>
        )}
        
        {/* Load all button - show when not all items are loaded */}
        {currentCount < totalCount && (
          <AutoLayout 
            fill="#FAECFF"
            cornerRadius={8} 
            padding={{ vertical: 4, horizontal: 8 }} 
            onClick={() => setPageDisplayCounts({
              ...pageDisplayCounts,
              [pageName]: totalCount
            })}
            hoverStyle={{ fill: "#EFC8FD" }}
          >
            <Text fontSize={10} fill="#8C00BA">{`Показать все (${safeText(totalCount)})`}</Text>
          </AutoLayout>
        )}
        
        {/* Reset button - show when more than CHUNK_SIZE items are loaded */}
        {currentCount > CHUNK_SIZE && (
          <AutoLayout 
            fill="#FAECFF"
            cornerRadius={8} 
            padding={{ vertical: 4, horizontal: 8 }} 
            onClick={() => setPageDisplayCounts({
              ...pageDisplayCounts,
              [pageName]: CHUNK_SIZE
            })}
            hoverStyle={{ fill: "#EFC8FD" }}
          >
            <Text fontSize={10} fill="#8C00BA">{`Свернуть до ${safeText(CHUNK_SIZE)}`}</Text>
          </AutoLayout>
        )}
      </AutoLayout>
    )
  }

  const runDeepScanCurrentPage = async () => {
    setIsDeepScanning(true)
    setAuditData([])
    setPageProgress([])
    setExpandedPages([])
    setExpandedComponents([])
    setPageDisplayCounts({})
    setSelectionError(null)
    setLastScanMode('page')

    try {
      setCurrentProgress('Глубокий скан текущей страницы…')
      const currentPage = figma.currentPage
      const safeCurrentPageName = (currentPage.name || '').trim() || 'Current Page'

      setPageProgress([{
        name: safeCurrentPageName,
        status: 'loading',
        componentCount: 0
      }])

      buildSlugRegistry([currentPage])
      await buildTokenMaps()
      const pageComponents = await processPageComponents(currentPage)

      setPageProgress([{
        name: safeCurrentPageName,
        status: 'complete',
        componentCount: pageComponents.length
      }])

      // Clean and serialize the data before storing
      try {
        const cleanedComponents = cleanComponentData(pageComponents)
        setAuditData(cleanedComponents)
      } catch (dataError) {
        console.error(`Error setting audit data for current page:`, dataError)
        setAuditData([]) // Fallback to empty array
      }

      setExpandedPages([safeCurrentPageName])
      setPageDisplayCounts({ [safeCurrentPageName]: CHUNK_SIZE })
      setCurrentProgress(`Глубокий скан завершён: найдено ${pageComponents.length} комп.`)

      setLastScanTime(new Date().toUTCString())
      
      // Auto-collapse the progress accordion after scan completes
      setTimeout(() => {
        setIsProgressExpanded(false)
      }, 1000)
        
    } catch (error) {
      console.error('Error during deep scan:', error)
      setCurrentProgress('Ошибка при глубоком скане')
    } finally {
      setIsDeepScanning(false)
      setTimeout(() => {
        setCurrentProgress('')
        setPageProgress([])
      }, 3000)
    }
  }

  const runScanSelection = async () => {
    const selection = figma.currentPage.selection
    
    // Check if something is selected
    if (selection.length === 0) {
      setSelectionError('Выделите компонент для сканирования')
      return
    }
    
    // Find all components in the selection
    const selectedComponents: ComponentNode[] = []
    
    selection.forEach(node => {
      if (node.type === 'COMPONENT') {
        selectedComponents.push(node as ComponentNode)
      } else if (node.type === 'COMPONENT_SET') {
        // If component set is selected, get all its variants
        const variants = (node as ComponentSetNode).findAll((n: SceneNode) => n.type === 'COMPONENT') as ComponentNode[]
        selectedComponents.push(...variants)
      } else if ('findAll' in node) {
        // Check if selection contains any components
        const componentsInside = node.findAll((n: SceneNode) => n.type === 'COMPONENT') as ComponentNode[]
        selectedComponents.push(...componentsInside)
      }
    })
    
    if (selectedComponents.length === 0) {
      setSelectionError('В выделении нет компонентов')
      return
    }
    
    // Clear any previous error
    setSelectionError(null)
    setLastScanMode('selection')

    setIsDeepScanning(true)
    setAuditData([])
    setPageProgress([])
    setCurrentProgress(`Сканирую ${selectedComponents.length} комп. из выделения…`)
    
    try {
      const currentPage = figma.currentPage
      const safePageName = (currentPage.name || '').trim() || 'Current Page'
      
      setPageProgress([{
        name: safePageName,
        status: 'loading',
        componentCount: selectedComponents.length
      }])
      
      const processedComponentSets = new Set<string>()
      const result: ComponentAuditData[] = []

      buildSlugRegistry([currentPage])
      await buildTokenMaps()

      // Process each selected component
      for (const component of selectedComponents) {
        let componentSetName: string | undefined
        let variantProperties: Record<string, string> | undefined
        let displayName = (component.name || '').trim() || 'Unnamed Component'
        let isVariant = false
        // Selection results have no set rows — attach set-level naming findings
        // to the first scanned variant of each set
        let setNamingFindings: UnboundProperty[] = []

        if (component.parent && component.parent.type === 'COMPONENT_SET') {
          const componentSet = component.parent as ComponentSetNode
          componentSetName = (componentSet.name || '').trim() || 'Unnamed Component Set'

          if (!processedComponentSets.has(componentSet.id)) {
            processedComponentSets.add(componentSet.id)
            setNamingFindings = checkComponentNaming(componentSet)
          }

          try {
            variantProperties = component.variantProperties || {}
            isVariant = true
          } catch (error) {
            console.warn('Error getting variant properties:', error)
            variantProperties = {}
          }
        }

        const unboundCheck = checkForUnboundProperties(component)
        const misuseFindings = await checkTokenMisuse(component)
        const namingFindings = isVariant
          ? [...setNamingFindings, ...checkLayerNaming(component)]
          : [...checkComponentNaming(component), ...checkLayerNaming(component)]
        const allProperties = [...unboundCheck.properties, ...misuseFindings, ...namingFindings]
        const usedComponents = await collectUsedComponents(component)

        result.push({
          id: component.id,
          name: displayName,
          componentSetName,
          variantProperties,
          pageName: safePageName,
          hasDescription: hasDescription(component),
          hasDocumentationLink: hasDocumentationLink(component),
          hasUnboundProperties: allProperties.length > 0,
          unboundProperties: allProperties,
          isHiddenFromPublishing: isHiddenFromPublishing(componentSetName || displayName),
          isOnCurrentPage: true,
          isVariant,
          usedComponents: usedComponents.length > 0 ? usedComponents : undefined,
          hasExpandableContent: allProperties.length > 0 || usedComponents.length > 0
        })
      }

      setPageProgress([{
        name: safePageName,
        status: 'complete',
        componentCount: selectedComponents.length
      }])
      
      // Clean and serialize the data before storing
      try {
        const cleanedComponents = cleanComponentData(result)
        setAuditData(cleanedComponents)
      } catch (dataError) {
        console.error(`Error setting audit data for selection:`, dataError)
        setAuditData([])
      }
      
      setExpandedPages([safePageName])
      setPageDisplayCounts({ [safePageName]: SELECTION_CHUNK_SIZE })
      setCurrentProgress(`Скан завершён: найдено ${selectedComponents.length} комп. в выделении`)
      setLastScanTime(new Date().toUTCString())
      
      // Auto-collapse the progress accordion after scan completes
      setTimeout(() => {
        setIsProgressExpanded(false)
      }, 1000)
      
    } catch (error) {
      console.error('Error scanning selection:', error)
      figma.notify('❌ Ошибка сканирования выделения', { error: true })
      setCurrentProgress('Ошибка при сканировании')
    } finally {
      setIsDeepScanning(false)
      // Clear page progress after a delay
      setTimeout(() => {
        setPageProgress([])
      }, 3000)
    }
  }

  return (
    <AutoLayout direction="vertical" spacing={16} padding={16} fill="#FFFFFF" cornerRadius={16} stroke="#eee" width={560} height="hug-contents">
      <AutoLayout direction="horizontal" spacing={12} width="fill-parent">
        <AutoLayout direction="vertical" spacing={4} width="fill-parent">
          <AutoLayout direction="horizontal" spacing={4} width="fill-parent" verticalAlignItems="center">
            <Text fontSize={12} fontWeight={700}>🔍</Text>
            <Text fontSize={16} fontWeight={700}>Аудит компонентов</Text>
          </AutoLayout>
          {!isDeepScanning && auditData.length === 0 && (
            <Text fontSize={12} fill="#333" horizontalAlignText="center">
              Выберите тип сканирования для анализа компонентов.
            </Text>
          )}
      </AutoLayout>

        {auditData.length > 0 && (
          <AutoLayout direction="horizontal" spacing={8}>
            <AutoLayout 
              fill="#1976D2"
              cornerRadius={8} 
              padding={{ vertical: 4, horizontal: 8 }} 
              onClick={rescan}
              hoverStyle={{ fill: "#1565C0" }}
              width="hug-contents"
            >
              <Text fontSize={10} fill="#FFFFFF">Пересканировать</Text>
            </AutoLayout>
            <AutoLayout 
              fill="#F44336"
              cornerRadius={8} 
              padding={{ vertical: 4, horizontal: 8 }} 
              onClick={resetAll}
              hoverStyle={{ fill: "#D32F2F" }}
              width="hug-contents"
            >
              <Text fontSize={10} fill="#FFFFFF">Сброс</Text>
            </AutoLayout>
          </AutoLayout>
        )}
      </AutoLayout>

    {/* Scan Options — shown while no scan is active or completed */}
    {!isDeepScanning && auditData.length === 0 && (
      <AutoLayout direction="vertical" spacing={12} width="fill-parent">
        <AutoLayout direction="vertical" spacing={8} width="fill-parent">
          
          {/* Selection Scan Option */}
          <AutoLayout direction="vertical" spacing={8} padding={12} fill="#ECFEED" stroke="#CDEED0" strokeWidth={1} cornerRadius={16} width="fill-parent">
            <AutoLayout direction="vertical" spacing={4} width="fill-parent">
              <AutoLayout direction="horizontal" spacing={4} verticalAlignItems="center">
                <SelectionIcon color="#2E7D32" size={16} />
                <Text fontSize={12} fontWeight={600} fill="#2E7D32">Выделение</Text>
              </AutoLayout>
              <Text fontSize={11} fill="#2E7D32" width="fill-parent">
                Детальный анализ выделенных компонентов. Удобно для точечных проверок.
              </Text>
            </AutoLayout>
            
            {selectionError && (
              <AutoLayout direction="vertical" spacing={4} padding={8} fill="#EC2F4C" cornerRadius={8} width="fill-parent">
                <Text fontSize={11} fill="#FFEBEB" fontWeight={600}>⚠️ {selectionError}</Text>
              </AutoLayout>
            )}
            
            <AutoLayout 
              fill="#D3F9D6"
              cornerRadius={8} 
              padding={{ vertical: 6, horizontal: 10 }} 
              stroke="#4CAF50"
              strokeWidth={1}
              onClick={runScanSelection}
              hoverStyle={{ fill: "#E3FBE5" }}
              width="hug-contents"
            >
              <Text fontSize={12} fill="#1B5E20" fontWeight={600}>Сканировать выделение</Text>
            </AutoLayout>
          </AutoLayout>

          {/* Current Page Deep Scan Option */}
          <AutoLayout direction="vertical" spacing={8} padding={12} fill="#F0F8FF" stroke="#C8E5FF" strokeWidth={1} cornerRadius={16} width="fill-parent">
            <AutoLayout direction="vertical" spacing={4} width="fill-parent">
              <AutoLayout direction="horizontal" spacing={4} verticalAlignItems="center">
                <CurrentPageIcon color="#1976D2" size={16} />
                <Text fontSize={12} fontWeight={600} fill="#1976D2">Текущая страница</Text>
              </AutoLayout>
              <Text fontSize={11} fill="#1976D2" width="fill-parent">
                Детальный анализ компонентов текущей страницы, включая непривязанные свойства.
              </Text>
            </AutoLayout>
            <AutoLayout 
              fill="#CFE9FD"
              cornerRadius={8} 
              padding={{ vertical: 6, horizontal: 10 }} 
              stroke="#2B94EB"
              strokeWidth={1}
              onClick={runDeepScanCurrentPage}
              hoverStyle={{ fill: "#DFF0FE" }}
              width="hug-contents"
            >
              <Text fontSize={12} fill="#0C4990" fontWeight={600}>Сканировать страницу</Text>
            </AutoLayout>
          </AutoLayout>

        </AutoLayout>
      </AutoLayout>
    )}

      {/* Deep Scan Results */}
      {auditData.length > 0 && (
        <>
        <AutoLayout direction="vertical" spacing={2} width="fill-parent">
            <AutoLayout width="fill-parent">
              <Text fontSize={14} fontWeight={600}>Результаты глубокого анализа</Text>
            </AutoLayout>
            <AutoLayout width="fill-parent">
              {lastScanTime && (
                <Text fontSize={11} fill="#333333">
                  {`Скан: ${safeText(lastScanTime)} (${lastScanMode === 'selection' ? 'выделение' : 'текущая страница'})`}
        </Text>
      )}
            </AutoLayout>
          </AutoLayout>
  
          {/* Settings Panel */}
          <AutoLayout direction="vertical" spacing={0} width="fill-parent" fill="#f9f9f9" cornerRadius={12}>
            <AutoLayout 
              direction="horizontal" 
              spacing={8} 
              padding={12} 
              verticalAlignItems="center" 
              width="fill-parent"
              onClick={() => setIsSettingsExpanded(!isSettingsExpanded)}
            >
              {isSettingsExpanded ? (
                <ChevronDownIcon color="#333333" size={14} />
              ) : (
                <ChevronRightIcon color="#333333" size={14} />
              )}
              <Text fontSize={12} fontWeight={600} fill="#333333">Настройки</Text>
            </AutoLayout>
            
            {isSettingsExpanded && (
              <SettingsPanel
                settings={settings}
                setSettings={setSettings}
                isIndividualPropsExpanded={isIndividualPropsExpanded}
                setIsIndividualPropsExpanded={setIsIndividualPropsExpanded}
                ignoredCount={ignoredFindings.length}
                onResetIgnores={() => setIgnoredFindings([])}
              />
            )}
          </AutoLayout>
  
          {/* Progress for deep scan */}
          <ProgressIndicator />
  
          {/* Page controls */}
          {getPageData().length > 1 && (
        <AutoLayout direction="horizontal" spacing={8} verticalAlignItems="center">
          <AutoLayout 
                fill="#eee" 
                cornerRadius={6} 
                padding={{ vertical: 4, horizontal: 6 }} 
            onClick={() => toggleAllPages(true)}
                hoverStyle={{ fill: "#ddd" }}
          >
                <Text fontSize={10} fill="#333333">Развернуть все страницы (Figma может упасть!)</Text>
          </AutoLayout>
          <AutoLayout 
                fill="#eee" 
                cornerRadius={6} 
                padding={{ vertical: 4, horizontal: 6 }} 
            onClick={() => toggleAllPages(false)}
                hoverStyle={{ fill: "#ddd" }}
          >
                <Text fontSize={10} fill="#333333">Свернуть все страницы</Text>
          </AutoLayout>
        </AutoLayout>
      )}
  
                    {/* Page Accordions */}
          <AutoLayout direction="vertical" spacing={8} width="fill-parent">
      {(getPageData() || []).map((pageData, index) => (
        <AutoLayout key={`${safeText(pageData.pageName)}-${index}`} direction="vertical" spacing={8} width="fill-parent">
          <PageAccordion pageData={pageData} />
          {pageData.isExpanded && (
            <LoadAllButton 
              pageName={safeText(pageData.pageName)} 
              totalCount={pageData.components?.length || 0} 
            />
          )}
        </AutoLayout>
      ))}
        </AutoLayout>      
        </>
      )}  
    </AutoLayout>
  )
}

widget.register(Widget)