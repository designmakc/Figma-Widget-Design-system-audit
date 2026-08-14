# DS Audit — Figma-виджет аудита дизайн-системы Genlab

Внутренний виджет для аудита компонентов в Figma: находит непривязанные свойства (hardcoded-значения вместо токенов) **и проверяет соответствие правилам нашей дизайн-системы** (`docs/rules/` в DS-репо, v1.3.0+).

Основан на MIT-виджете «Component Audit» Luis Ouriach — см. [LICENSE](LICENSE).

## Что проверяет

### Базовые проверки (unbound-детект)

- заливки, обводки (цвет и толщина), типографика, радиусы углов, отступы auto-layout, эффекты, прозрачность — всё без привязанной переменной или стиля;
- метаданные: описание компонента, ссылка на документацию;
- статус публикации (префиксы `.` / `_`).

### Проверки правил ДС (semantic-fit токенов)

Не только «привязано ли», но и «привязан ли **правильный** токен»:

| Правило | Что ловит |
|---|---|
| `spacing-category-property-match` | gap-свойство с `*/padding/*` или `*/margin/*` токеном и наоборот |
| `spacing-layout-vocabulary` | второй сегмент раскладочного токена не источник изменчивости: `layout/{container\|page\|card}/…` (rules 1.10.1) |
| `spacing-region-scope` | `layout/page/*` внутри компонента |
| `spacing-bind-semantic-layer` | привязка из любой не-semantic коллекции (`device`, `container`, `isloading`) — кроме BOOLEAN-переключателей и мостов |
| `tier-discipline` | привязка primitive-токена напрямую |
| `tokens-no-disabled-suffix-leaf` (DEC-024) | токены с leaf `<word>Disabled` |
| `tokens-no-component-tier` (DEC-014) | сегмент токена совпадает с именем компонента |
| `gradient-stop-unbound` (DEC-036) | стопы градиентов без переменных |

### Naming-проверки

- имя компонента PascalCase (DEC-032), свойства camelCase (DEC-007), boolean-префиксы `is*`/`has*` (DEC-031);
- компонент в секции `subComponent` — имя со строчной буквы (`ASM-026`); PascalCase-правило на него не распространяется;
- глоссарий Tier-1 осей: анти-имена (`style`→`variant`, `status`→`state`, …) и канонические enum-values осей `state`/`variant`/`labelPosition` (DEC-025/030);
- имена слоёв camelCase (DEC-008), с умными пропусками (INSTANCE, авто-именованный текст).

Каждое правило отключается отдельным тумблером в настройках («Правила ДС»).

**Полный реестр проверок с источниками и упрощениями — [CHECKS.md](CHECKS.md).** Обновлять при каждом изменении проверок.

## Режимы сканирования

- **Выделение** — глубокий анализ выделенных компонентов.
- **Текущая страница** — глубокий анализ всех компонентов страницы.

Оба режима дают полный набор проверок: непривязанные свойства + правила ДС. Скан всего файла и быстрый обзор убраны (2026-08-12) — на больших файлах Figma падала, а сводка дублировала первую страницу отчёта.

## Установка

```bash
npm install
npm run build
```

В Figma: **Widgets → Development → Import widget from manifest…** → выбрать `manifest.json` из корня репо.

## Разработка

```bash
npm run watch   # пересборка при изменениях
npm run tsc     # проверка типов
npm test        # self-check чистых хелперов semantic-проверки
```

Весь код виджета — [`widget-src/code.tsx`](widget-src/code.tsx). DS-проверки — блок `checkTokenMisuse` + `DS_RULE_SETTINGS` (искать по `DS token semantic-fit checks`).

## Связь с DS-репо

Правила зашиты константами в `code.tsx`. Синхронизировано с **rules v1.10.1** и **tokens v4.0.0** (сверено с живым `Base` 2026-08-13). Виджет не читает ни `docs/rules/`, ни `tokens/current` — при bump'е правил ДС константы правятся вручную, затем `npm run build` и перезагрузка виджета в Figma.

Что смотреть при следующем bump'е: `DS_LAYOUT_NAMESPACE` / `DS_LAYOUT_LEGACY` (словарь `layout/`), `dsIsSemanticCollection` (коллекции), `DS_STATE_ENUM` / `DS_VARIANT_ENUM` / `DS_LABELPOS_ENUM` / `DS_PRIORITY_ENUM` / `DS_GLOSSARY_ANTINAMES` (glossary осей), `DS_SUBCOMPONENT_SECTION` (имена секций).

Известное упрощение: у стопов градиентов проверяется только факт привязки, без проверки префикса `color/gradient/*` — живые переменные пока без `color/`-префикса (rename pending, DEC-036).
