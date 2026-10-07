# Интеграция с агентами

LM Tools, MCP и `code-embed --json` используют общий контракт двух инструментов (`packages/protocol/src/tools.ts`).

## Инструменты

`search`:

| Поле | Описание |
| --- | --- |
| `query` | обязательное, запрос на любом языке, в том числе русском |
| `mode` | `hybrid` (по умолчанию), `semantic`, `lexical` |
| `top` | 1-50 |
| `include`, `exclude` | массивы масок путей от корня проекта |
| `lang` | идентификатор языка |

`find_similar`: либо `{ path, start_line, end_line, top? }` (1-based, включительно), либо `{ code, lang?, top? }`. Смешивать формы нельзя.

Результат: ранжированные чанки (путь, диапазон строк, символ, фрагмент). Инструменты не заменяют grep: для точного идентификатора, строки, текста ошибки и списка использований символа используйте grep/ripgrep.

## VS Code (LM Tools)

Расширение регистрирует `#semsearch` (`search`) и `#similar` (`find_similar`). На них можно сослаться в чате (`#semsearch где обрабатывается возврат платежа`); агент также вызывает их сам по описанию инструмента.

## MCP

```bash
code-embed mcp --root /path/to/project
```

stdio MCP-сервер с инструментами `search` и `find_similar`. Корень: текущая папка или `--root`. stdout занят протоколом, логи идут в stderr.

### Copy MCP Config

Команда `Code Embed: Copy MCP Config` кладёт в буфер JSON для `mcp.json` Cursor и Windsurf:

```json
{
  "mcpServers": {
    "code-embed": { "command": "npx", "args": ["-y", "code-embed@0.1.0", "mcp", "--root", "/path/to/project"] }
  }
}
```

Версия и корень подставляются автоматически.

## CLI для агентов

`code-embed --json "<запрос>"` печатает результаты JSON lines; код выхода 1 означает «ничего не найдено». Готовое правило для `CLAUDE.md` / `AGENTS.md` находится в разделе «Фрагмент для CLAUDE.md / AGENTS.md» файла [README](../README.md).
