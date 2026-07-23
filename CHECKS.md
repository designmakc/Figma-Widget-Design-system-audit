# Реестр проверок DS Audit

Живой документ: что проверяет виджет, откуда правило, статус реализации. Обновлять при каждом добавлении/изменении проверки. Источник правил — DS-репо `docs/rules/` (rules v1.3.0, 2026-07-22).

Все находки DS-правил выводятся в группе «🚨 Нарушения правил ДС» с `ruleId`; каждое правило отключается тумблером в Настройки → Отдельные свойства.

## 1. Базовые unbound-проверки (унаследованы от Component Audit, MIT)

Проверяют «привязано ли» — hardcoded-значение без переменной/стиля. Функция `checkForUnboundProperties`.

| Проверка | Что ловит | Примечания |
|---|---|---|
| Fill | SOLID-заливка без переменной и без стиля | |
| Stroke Color / Weight | цвет и толщина обводки раздельно, per-side weights | |
| Typography | fontFamily / fontSize / lineHeight без переменной | |
| Corner Radius | общий и поугловые радиусы | фикс: все 4 угла привязаны поугловно при равных значениях → НЕ нарушение (2026-07-23) |
| Spacing | paddingTop/Right/Bottom/Left, itemSpacing, gap | `SPACE_BETWEEN` пропускается; **grid-фикс**: при `layoutMode === 'GRID'` itemSpacing/gap не проверяются (остаточные flow-свойства, false positive) |
| Effects | тень/blur: цвет, offset, radius, spread | |
| Opacity | любое значение без переменной (вкл. 100%) | по умолчанию тумблер «Прозрачность» выключен |
| Метаданные | описание, ссылка на документацию | |
| Публикация | префиксы `.` / `_` | |

## 2. Semantic-fit токенов (B-блок, 2026-07-23)

Проверяют «привязан ли **правильный** токен». Функция `checkTokenMisuse` — async, резолвит имя и коллекцию переменной (`figma.variables.getVariableByIdAsync`, кэш на сессию).

| ruleId | Источник | Enforcement | Что ловит |
|---|---|---|---|
| `spacing-category-property-match` | `docs/rules/tokens/spacing.md`, v1.3.0 | hard | gap-свойства (`itemSpacing`, `counterAxisSpacing`, `gap`) с токеном `*/padding/*` или `*/margin/*`; padding-свойства с `*/gap/*` |
| `spacing-layout-vocabulary` | `docs/rules/tokens/spacing.md`, v1.3.0 | hard | `layout/`-токен вне закрытого словаря `layout/{page/margin\|container/padding\|content/gap}/{horizontal\|vertical}`, `layout/grid/gutter` — ловит дореформенные имена (`layout/page/vertical`, `layout/content/paddingX`) |
| `spacing-region-scope` | `docs/rules/tokens/spacing.md`, v1.3.0 | hard (в виджете — «на ревью») | `layout/page/*` внутри компонента; легален только для позиционирования полноэкранного оверлея от вьюпорта — машинно не различить, поэтому формулировка «проверить» |
| `spacing-bind-semantic-layer` | `docs/rules/tokens/spacing.md`, v1.3.0 | hard | прямая привязка переменной из коллекции `device`; исключения by design: `visible/*`, `system/device` |
| `tier-discipline` | `docs/rules/tokens/tier-discipline.md` | soft | привязка primitive-токена (коллекция `primitive*` или путь `primitive/*`) вместо semantic-слоя |
| `tokens-no-disabled-suffix-leaf` | `docs/rules/tokens/tier-discipline.md`, DEC-024 | hard | привязанный токен с leaf `<word>Disabled` (`bgDisabled`, `indicatorDisabled`); disabled реализуется через `opacity/disabled` overlay (DEC-023) |
| `tokens-no-component-tier` | `docs/rules/tokens/tier-discipline.md`, DEC-014 | soft | middle-segment имени токена совпадает с именем component-set из сканируемых страниц (реестр слагов строится на старте скана) |
| `gradient-stop-unbound` | `docs/rules/tokens/gradients.md`, DEC-036 | hard | стоп градиента (fill/stroke) без привязанной переменной цвета |

Универсальные проверки (`spacing-bind-semantic-layer`, `tier-discipline`, DEC-024, DEC-014) применяются ко **всем** привязкам: spacing, fills, strokes, радиусы, strokeWeight, opacity.

## 3. Naming-проверки (A-блок, 2026-07-23)

Функции `checkComponentNaming` (уровень component-set / standalone-компонента) и `checkLayerNaming` (слои внутри варианта). Находки уровня сета висят на строке сета (в скане выделения — на первом варианте сета).

| ruleId | Источник | Enforcement | Что ловит |
|---|---|---|---|
| `component-name-pascalcase` | `docs/rules/components/component-name.md`, DEC-032 | hard | имя component-set / standalone-компонента не PascalCase (`^[A-Z][a-zA-Z0-9]*$`): camelCase, пробелы, kebab, underscore |
| `component-property-camelcase` | `docs/rules/components/properties.md`, DEC-007 | hard | имя свойства не camelCase (`^[a-z][a-zA-Z0-9]*$`); `#id`-суффикс Figma отрезается до проверки |
| `boolean-prefix-convention` | `docs/rules/components/boolean-prefix.md`, DEC-031 | hard | boolean-свойство (BOOLEAN или VARIANT с options `true/false`) без префикса `is*`/`has*`; `show*` — отдельная подсказка «переименовать в has*» |
| `component-property-tier1-glossary` | `docs/rules/components/property-glossary.md`, DEC-025 | soft | анти-имена осей: `style`→`variant`, `buttonSize`→`size`, `level`/`weight`→`priority`, `status`/`mode`→`state`, `side`→`labelPosition`; values осей `variant` (⊆ solid\|outline\|ghost\|unstyled) и `labelPosition` (⊆ left\|right) вне канона |
| `state-axis-canonical-enum` | `docs/rules/components/states.md`, DEC-030 | soft | значения оси `state` вне канонического enum `default\|hover\|focus\|empty\|filled\|loading\|success\|error\|disabled` |
| `layer-naming-camelcase` | `docs/rules/components/layers.md`, DEC-008 | hard | имя слоя не camelCase. Пропускаются: INSTANCE (имя от master-компонента — норма), TEXT с `autoRename` (авто-имя из контента) |

## Известные упрощения

- **Стопы градиентов**: проверяется только факт привязки, без префикса `color/gradient/*` — живые переменные пока без `color/`-префикса (rename pending, DEC-036). Добавить проверку префикса после rename.
- **`spacing-region-scope`**: `layout/page/*` на Viewport-обёртке полноэкранного оверлея легален — виджет не различает, флажит как «проверить».
- **`tokens-no-component-tier`**: реестр слагов — только component-set'ы сканируемых страниц; при скане одной страницы токен с именем компонента с другой страницы не поймается.
- **`layer-naming-camelcase`**: внутрь INSTANCE не заходим (внутренности — зона master-компонента). Дефолтные Figma-имена (`Frame 123`, `Ellipse 1`) — валидные нарушения по правилу, но их может быть много: тумблер «Имена слоёв» позволяет отключить.
- **`size`-ось не проверяется** на канон values: enum расширяемый (`lg|md|sm`, DEC-025), закрытого списка нет.
- **Grid auto-layout**: `itemSpacing`/`gap` не проверяются вовсе (и unbound, и semantic-fit) — Figma хранит там устаревшие flow-значения.

## Кандидаты (не реализовано)

- Modes-coverage: у привязанной переменной есть значения во всех 4 brand-modes (MC/SC/FC/AC).
- `paint.opacity` = alpha привязанного токена — подавление false positive (сейчас opacity-проверка отключаема тумблером целиком).
- Проверка `color/gradient/*`-префикса стопов (после rename переменных).
- Semantic-fit цветовых категорий (`color/action/*` на actionable-элементах и т.п.) — эвристика, нужен словарь ролей слоёв.
