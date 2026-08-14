# Реестр проверок DS Audit

Живой документ: что проверяет виджет, откуда правило, статус реализации. Обновлять при каждом добавлении/изменении проверки. Источник правил — DS-репо `docs/rules/` (**rules v1.10.1**, 2026-08-12) и словарь токенов `tokens/current` (**tokens v4.0.0**, 2026-08-12), сверено с живым `Base` 2026-08-13.

Все находки DS-правил выводятся в группе «🚨 Нарушения правил ДС» с `ruleId`; каждое правило отключается тумблером в Настройки → Отдельные свойства.

**Действия на находке:** «Игнор» — скрыть конкретное замечание (список персистентный, сброс — «Сбросить игноры (N)» в настройках); «Исправить» — авто-фикс, есть у переименований (`layer-naming-camelcase` → camelCase, `component-name-pascalcase` → PascalCase): переименовывает узел прямо в Figma; «Привязать» — на unbound-находках числовых свойств, когда в semantic-коллекциях есть FLOAT-токен с точно таким значением (подсказка «→ есть токен с этим значением: …»): привязывает переменную к свойству.

**Подсказка токена («Привязать»):** карты значение→токен строятся на старте скана из local-переменных FLOAT и COLOR (алиасы резолвятся до 4 уровней; берутся **только** semantic-коллекции — `semantic`, `semanticV2`; `device`, `isloading`, `primitive*` исключены). Категория токена согласована с `spacing-category-property-match`: gap-свойства ← только `*/gap/*`, padding ← `*/padding/*`, радиусы ← `radius/*`, толщина обводки ← `borderWidth/*`. При нескольких кандидатах берётся кратчайшее имя. `cornerRadius` (unified) биндится на все четыре угла. Ограничение: значение сверяется по default-mode коллекции — если узел живёт в другом device/brand-mode с иным значением, подсказки не будет.

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
| `spacing-layout-vocabulary` | `docs/rules/tokens/naming.md` → `token-name-variability-namespace`, v1.10.1 | hard | **второй** сегмент раскладочного токена обязан быть источником изменчивости: `layout/{container\|page\|card}/…`. Ловит дореформенные ветки (`layout/page/margin/*`, `layout/section/*`, `layout/content/*`) и раскладочные токены, оставшиеся без корня `layout/` (`container/padding/*` — схема 1.10.0, прожила один день). Проверяется **только на semantic**: внутри `device`/`container` те же токены живут с укороченными именами (`layout/page/*`, `layout/gap/*`) — это фасадные ветки, а не нарушение |
| `spacing-region-scope` | `docs/rules/tokens/spacing.md`, v1.3.0 | hard (в виджете — «на ревью») | `layout/page/*` внутри компонента; легален только для позиционирования полноэкранного оверлея от вьюпорта — машинно не различить, поэтому формулировка «проверить» |
| `spacing-bind-semantic-layer` | `docs/rules/tokens/tier-discipline.md` + `spacing.md`, v1.3.0 | hard | привязка переменной из **любой** не-semantic коллекции (живые на 2026-08-13: `device`, `container`, `isloading`, `primitive`); исключения by design: BOOLEAN-переменные (переключатели `system/visible/*`, `isloading/skeleton/*`), STRING-мосты `system/device` / `device`, привязки на `componentProperties.*` (мост «мода → variant property»), служебные коллекции плагина uSpec `Specs` / `Specs Layout` |
| `tier-discipline` | `docs/rules/tokens/tier-discipline.md` | soft | привязка primitive-токена (коллекция `primitive*` или путь `primitive/*`) вместо semantic-слоя |
| `tokens-no-component-tier` | `docs/rules/tokens/tier-discipline.md`, DEC-014 | soft | middle-segment имени токена совпадает с именем component-set из сканируемых страниц (реестр слагов строится на старте скана) |
| `gradient-stop-unbound` | `docs/rules/tokens/gradients.md`, DEC-036 | hard | стоп градиента (fill/stroke) без привязанной переменной цвета |

Универсальные проверки (`spacing-bind-semantic-layer`, `tier-discipline`, DEC-014) применяются ко **всем** привязкам узла: `boundVariables` обходится целиком (`dsCollectBindings`) — массивы (`fills`, `strokes`, `effects`), одиночные алиасы (spacing, радиусы, `strokeWeight`, `opacity`, типографика) и карты (`componentProperties`). Списка полей больше нет: раньше текстовые, эффектные и размерные привязки молча не проверялись.

**Семантическая замена (2026-08-12).** Находка `spacing-bind-semantic-layer` / `tier-discipline` несёт кнопку «Привязать», если в semantic-коллекциях есть токен с тем же значением: для FLOAT — по значению и категории свойства, для COLOR — по 8-битной подписи RGBA. Замена применяется на месте: числовые поля через `setBoundVariable`, заливки и обводки через `setBoundVariableForPaint` (поле находки — `fills[0]` / `strokes[0]`).

## 3. Naming-проверки (A-блок, 2026-07-23)

Функции `checkComponentNaming` (уровень component-set / standalone-компонента) и `checkLayerNaming` (слои внутри варианта). Находки уровня сета висят на строке сета (в скане выделения — на первом варианте сета).

| ruleId | Источник | Enforcement | Что ловит |
|---|---|---|---|
| `component-name-pascalcase` | `docs/rules/components/component-name.md`, DEC-032 | hard | имя component-set / standalone-компонента не PascalCase (`^[A-Z][a-zA-Z0-9]*$`): camelCase, пробелы, kebab, underscore. **Не применяется** к компонентам в секции `subComponent` — там действует правило ниже |
| `subcomponent-name-lowercase` | `docs/rules/component-rule/naming.md` → `ASM-026`, уточнено 2026-08-13 | hard | компонент лежит в секции `SubComponent` / `_SubComponent` / `Subcomponent`, но имя начинается с заглавной. Префикс публикации (`.`, `_`) отделяется до проверки: `_stack` валиден, `_Processed` — нет. Авто-фикс «Исправить» переименовывает в camelCase, префикс сохраняется |
| `component-property-camelcase` | `docs/rules/components/properties.md`, DEC-007 | hard | имя свойства не camelCase (`^[a-z][a-zA-Z0-9]*$`); `#id`-суффикс Figma отрезается до проверки |
| `boolean-prefix-convention` | `docs/rules/components/boolean-prefix.md`, DEC-031 | hard | boolean-свойство (BOOLEAN или VARIANT с options `true/false`) без префикса `is*`/`has*`; `show*` — отдельная подсказка «переименовать в has*» |
| `component-property-tier1-glossary` | `docs/rules/components/property-glossary.md`, DEC-025 | soft | анти-имена осей: `style`→`variant`, `buttonSize`→`size`, `level`/`weight`→`priority`, `status`/`mode`→`state`, `side`→`labelPosition`; values осей `variant` (⊆ solid\|outline\|ghost\|unstyled), `labelPosition` (⊆ left\|right) и `priority` (⊆ neutral\|1\|2\|3\|4\|inverse) вне канона glossary v2 |
| `state-axis-canonical-enum` | `docs/rules/components/states.md`, DEC-030 | soft | значения оси `state` вне канонического enum `default\|hover\|focus\|empty\|filled\|loading\|success\|error\|disabled` |
| `layer-naming-camelcase` | `docs/rules/components/layers.md`, DEC-008 | hard | имя слоя не camelCase. Пропускаются: INSTANCE (имя от master-компонента — норма), TEXT с `autoRename` (авто-имя из контента) |

## Известные упрощения

- **Стопы градиентов**: проверяется только факт привязки, без префикса `color/gradient/*` — живые переменные пока без `color/`-префикса (rename pending, DEC-036). Добавить проверку префикса после rename.
- **`spacing-region-scope`**: `layout/page/*` на Viewport-обёртке полноэкранного оверлея легален — виджет не различает, флажит как «проверить».
- **`tokens-no-component-tier`**: реестр слагов — только component-set'ы текущей страницы (скана всего файла больше нет); токен с именем компонента с другой страницы не поймается.
- **Семантическая замена**: карты токенов строятся из **local**-переменных — в файле-потребителе, где semantic подключена как библиотека, замена не предложится (сама находка останется). Значение сверяется в default-моде коллекции: токен, различающийся только по бренду/девайсу, не подберётся.
- **Коллекция не резолвится** (remote-переменная): проверка «не-semantic коллекция» пропускается, остаётся только детект по имени `primitive/*` — иначе легальные библиотечные привязки давали бы ложные срабатывания пачками.
- **`layer-naming-camelcase`**: внутрь INSTANCE не заходим (внутренности — зона master-компонента). Дефолтные Figma-имена (`Frame 123`, `Ellipse 1`) — валидные нарушения по правилу, но их может быть много: тумблер «Имена слоёв» позволяет отключить.
- **`size`-ось не проверяется** на канон values: enum расширяемый (`lg|md|sm`, DEC-025), закрытого списка нет.
- **`subcomponent-name-lowercase`** — зеркало `ASM-026` из ветки сборки; тот же признак проверяет ревизор `audit-assembly.js` → `subComponentNameLower`. Признак «техническое» — секция, а не casing: до уточнения проверка спрашивала у нарушения, нарушение ли оно.
- **Словарь `layout/` проверяется по схеме, не по перечню.** Виджет не хранит список из 36 живых имён — только требование ко второму сегменту. Новый лист (`layout/container/foo`) не потребует правки виджета; переезд ветки — потребует.
- **Grid auto-layout**: `itemSpacing`/`gap` не проверяются вовсе (и unbound, и semantic-fit) — Figma хранит там устаревшие flow-значения.

## 4. Используемые компоненты (информационный блок, 2026-07-24)

Не проверка — **список зависимостей для разработчиков**: какие компоненты подключать в коде. Функция `collectUsedComponents`.

- Собираются master-компоненты всех INSTANCE внутри варианта (top-level: внутрь инстансов не спускаемся — их состав — зона master'а). Имя — component-set master'а (или имя компонента, если без сета). Компоненты из внешних библиотек помечаются « — внешняя библиотека».
- Показ: блок «📦 Используемые компоненты (N)» в раскрытии записи. На строке component-set — объединение по всем вариантам; на варианте — его собственный список (варианты могут отличаться: `hasIcon=false` не содержит `Icon`).
- Тумблер «Используемые компоненты» в верхнем ряду настроек; при включённом тумблере компонент с зависимостями попадает в результаты даже без нарушений (иначе dev не увидит список у «зелёного» компонента).

## Ретированные проверки

| ruleId | Было | Снято | Причина |
|---|---|---|---|
| `tokens-no-disabled-suffix-leaf` (DEC-024) | запрет leaf `<word>Disabled` у привязанных токенов | 2026-07-23 (rules v1.4.0) | в ДС появились disabled-токены: disabled легально реализуется и через `opacity/disabled` overlay, и через прямые disabled-токены цвета — см. `docs/rules/.audit/2026-07-23-disabled-tokens-legalized.md` |

## Кандидаты (не реализовано)

- Консистентность вариантов: частичная привязка между вариантами (в одном токен, в другом hardcoded), ось меняет не свою категорию свойств, дырки в матрице вариантов, расхождение дерева слоёв.
- Гигиена: скрытые слои-мусор, чужие инстансы (master вне whitelist fileKeys), дубли имён сетов.
- Типографика: переопределения поверх text style, шрифт вне брендового списка.
- A11y: touch target ≥ 44×44 у интерактивных компонентов; контраст по resolved-токенам (дорого).
- Values-casing вариант-осей («Default», «XL»).
- Suggest цветовых токенов по hex-значению (аналог «Привязать» для fills).
- Modes-coverage: у привязанной переменной есть значения во всех 4 brand-modes (MC/SC/FC/AC).
- `paint.opacity` = alpha привязанного токена — подавление false positive (сейчас opacity-проверка отключаема тумблером целиком).
- Проверка `color/gradient/*`-префикса стопов (после rename переменных).
- Semantic-fit цветовых категорий (`color/action/*` на actionable-элементах и т.п.) — эвристика, нужен словарь ролей слоёв.
