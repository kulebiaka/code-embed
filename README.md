# code-embed

Локальный гибридный (семантический + лексический) поиск по коду. Один индекс в `<корень проекта>/.code-embed/`, движок на Node.js, клиенты: расширение VS Code, CLI и AI-агенты (LM Tools, MCP). Код не покидает машину, пока вы сами не подключите внешнего провайдера эмбеддингов.

## Возможности

- Гибридный поиск: BM25 (SQLite FTS5) + kNN (sqlite-vec), слияние RRF. Режимы `hybrid`, `semantic`, `lexical`.
- Запросы на естественном языке, в том числе на русском: `где обрабатывается возврат платежа`.
- Поиск похожего кода (`similar`): по диапазону строк или по фрагменту из stdin.
- Чанкинг по синтаксическому дереву (tree-sitter) для TypeScript/JavaScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, Kotlin; Markdown по разделам; остальное окнами.
- Две фазы индексации: лексическая (поиск работает сразу) и векторная (в фоне).
- Встроенные локальные модели эмбеддингов (ONNX) и любой OpenAI-совместимый API.
- Расширение VS Code с панелью поиска, LM Tools `#semsearch` и `#similar`, MCP-сервер для Cursor, Windsurf, Claude Code.
- Телеметрии нет.

## Установка

### VS Code / Cursor / Windsurf

Установите расширение «Code Embed» из VS Code Marketplace или Open VSX (Cursor, Windsurf и другие форки используют Open VSX). VSIX собираются под каждую платформу и содержат движок. Модель по умолчанию (`qwen3-embedding-0.6b`, около 600 МБ) скачивается отдельно; команда `Code Embed: Install CLI` ставит CLI.

Команды (палитра, категория «Code Embed»): Focus (`Ctrl+Alt+F` / `Cmd+Alt+F`), Quick Search, Find Similar Code, Reindex Workspace, Install CLI, Copy MCP Config, Select Embedding Provider, Select Model, Test Provider, Show Log, Open Settings. Open Settings (шестерёнка в заголовке панели поиска) открывает страницу настроек: статус индекса, выбор и проверка провайдеров, API-ключи, каталог моделей, параметры индексации и поиска.

В панели поиска: `Alt+↑`/`Alt+↓` переключают режим (hybrid, semantic, lexical), стрелки ходят по результатам, `Enter` открывает результат, `Ctrl+Enter` / `Cmd+Enter` открывает его сбоку, `←` переходит к файлу и сворачивает группу, `→` разворачивает, `Esc` возвращает в поле запроса. У результата есть кнопки «открыть сбоку», «скопировать путь:строку» и «найти похожий код».

### CLI

```bash
npm i -g code-embed      # постоянная установка
npx code-embed "запрос"  # без установки
```

Требуется Node.js с поддержкой `node:sqlite` (см. `engines` в `packages/engine/package.json`). Оффлайн-установка модели: `code-embed model install --from FILE`.

## Быстрый старт

```bash
cd my-project
code-embed model install            # один раз: скачать модель по умолчанию
code-embed index                    # построить индекс (поиск также обновляет его сам)
code-embed "retry with exponential backoff"
code-embed -l -g 'src/**' -g '!**/*.test.ts' "parseConfig"
code-embed similar src/api/client.ts:40-72
code-embed --json -n 5 "где проверяется токен"
```

## CLI

Полный справочник: [docs/cli.md](docs/cli.md). Кратко:

| Команда | Назначение |
| --- | --- |
| `code-embed [OPTIONS] <QUERY>` | поиск |
| `code-embed similar <PATH>:<START>-<END>` / `similar -` | похожий код |
| `code-embed index [--watch] [--full]` | индексация |
| `code-embed status` / `stop` / `gc` / `clean` | состояние, остановка демона, сборка мусора, удаление индекса |
| `code-embed daemon [--detach]` | демон: движок + сокет + watcher |
| `code-embed mcp [--root DIR]` | MCP-сервер (stdio) |
| `code-embed model install\|list` | управление моделями |
| `code-embed provider list\|add\|test` | провайдеры эмбеддингов |
| `code-embed export` / `import` | перенос индекса |

Коды выхода: `0` успех, `1` нет результатов, `2` ошибка.

## Конфигурация

Подробности и таблица настроек VS Code: [docs/configuration.md](docs/configuration.md). Приоритет: флаги CLI, затем `.code-embed.toml` проекта, затем настройки редактора, затем пользовательский `config.toml`, затем значения по умолчанию.

### .code-embed.toml

Локальный файл в корне проекта, в MVP не коммитится: когда инструмент создаёт его, он добавляет строку `.code-embed.toml` в `.gitignore` (если её там нет).

```toml
exclude = ["vendor/**", "**/*.generated.ts"]

[embedding]
provider = "local"
model = "qwen3-embedding-0.6b"

[index]
location = "project"
max_file_kb = 512

[search]
default_mode = "hybrid"
top = 20
```

Адреса и ключи в этот файл не допускаются.

### Провайдеры эмбеддингов

Провайдер `local` использует встроенную модель. Остальные описываются в `providers.toml` (каталог конфигурации пользователя) или в настройке `codeEmbed.providers`:

```toml
[ollama]
kind = "openai"
base_url = "http://localhost:11434/v1"
model = "nomic-embed-text"

[remote]
kind = "openai"
base_url = "https://api.example.com/v1"
model = "text-embedding-3-small"
api_key_env = "EXAMPLE_API_KEY"
```

Выбор: `embedding.provider = "remote"` в `.code-embed.toml`, `--provider remote` или команда `Code Embed: Select Embedding Provider`. Проверка: `code-embed provider test remote`.

### Приватность

- Телеметрии нет. Сетевые обращения: скачивание модели и запросы к выбранному вами провайдеру.
- Провайдер на loopback (`localhost`, `127.0.0.1`, `::1`) или unix socket считается локальным, без предупреждений.
- Любой другой адрес считается внешним: перед первой отправкой кода требуется явное подтверждение для проекта («код будет отправлен на `<host>`»). Подтверждение хранится в `consents.toml`, общем для CLI и расширения. В CLI: интерактивный вопрос или `--allow-remote`.
- API-ключи не хранятся в конфигах, только имя переменной окружения (`api_key_env`).

## Интеграция с агентами

Подробности: [docs/agents.md](docs/agents.md). Все интерфейсы предоставляют два инструмента с общим контрактом: `search` и `find_similar`.

### VS Code (LM Tools)

Инструменты агентов VS Code: `#semsearch` (поиск) и `#similar` (похожий код). Доступны, когда расширение активно.

### MCP

`code-embed mcp` запускает stdio MCP-сервер; корень проекта — текущая папка или `--root`. Команда `Code Embed: Copy MCP Config` кладёт в буфер JSON для `mcp.json` Cursor/Windsurf:

```json
{
  "mcpServers": {
    "code-embed": { "command": "npx", "args": ["-y", "code-embed@0.1.0", "mcp", "--root", "/path/to/project"] }
  }
}
```

### Фрагмент для CLAUDE.md / AGENTS.md

```markdown
## Поиск по коду

- Для вопросов по смыслу («где обрабатывается X», «как работает Y»), поиска реализации
  концепции, когда точные идентификаторы неизвестны, и для запросов на русском вызывай
  `code-embed --json "<запрос>"` (или MCP-инструмент `search`). Сужай через `-g` / `include`
  и `--lang`.
- Перед рефакторингом или правкой бага ищи похожие места:
  `code-embed --json similar <path>:<start>-<end>` (или `find_similar`).
- Для точного идентификатора, строкового литерала, текста ошибки, имени файла и списка всех
  использований символа используй grep/ripgrep, а не code-embed.
- Результаты code-embed это ранжированные чанки; перед правкой прочитай указанные строки файла.
```

## Модели

Каталог встроенных моделей: `packages/engine/src/embed/models.json`. Модель по умолчанию `qwen3-embedding-0.6b`. Выбор: `codeEmbed.model.id`, `embedding.model`, `--model`. Список и статус установки: `code-embed model list`.

| Модель | Размерность | Размер | Лицензия |
| --- | --- | --- | --- |
| `qwen3-embedding-0.6b` | 1024 | 596 МБ | Apache-2.0 |
| `embeddinggemma-300m` | 768 | 316 МБ | gemma |
| `coderankembed-137m` | 768 | 133 МБ | MIT |
| `multilingual-e5-small` | 384 | 129 МБ | MIT |
| `bge-m3` | 1024 | 558 МБ | MIT |
| `potion-code-16m` | 256 | 62 МБ | MIT |

Оценка качества на наборах запросов (Recall@10, MRR): [eval/README.md](eval/README.md).

## Как это работает

Подробности: [docs/architecture.md](docs/architecture.md). Сканер обходит проект с учётом `.gitignore`, пропуская бинарные, минифицированные, слишком большие и сгенерированные файлы; файлы режутся на чанки; лексическая фаза заполняет FTS5, векторная фаза считает эмбеддинги (с глобальным кешем `emb.db`) и пишет их в sqlite-vec. Поиск объединяет BM25 и kNN через RRF.

## Лицензии

Продукт распространяется под лицензией MIT (файл [LICENSE](LICENSE)). Телеметрии нет.

Модели каталога скачиваются отдельно и сохраняют собственные лицензии:

| Модель | Лицензия |
| --- | --- |
| `qwen3-embedding-0.6b` | Apache-2.0 |
| `embeddinggemma-300m` | gemma (Gemma Terms of Use) |
| `coderankembed-137m` | MIT |
| `multilingual-e5-small` | MIT |
| `bge-m3` | MIT |
| `potion-code-16m` | MIT |

Грамматики tree-sitter (WASM, пакет `tree-sitter-wasms`, рантайм `web-tree-sitter`):

| Грамматика | Лицензия |
| --- | --- |
| `web-tree-sitter` (рантайм) | MIT |
| tree-sitter-typescript / tsx / javascript | MIT |
| tree-sitter-python | MIT |
| tree-sitter-go | MIT |
| tree-sitter-rust | MIT |
| tree-sitter-java | MIT |
| tree-sitter-c-sharp | MIT |
| tree-sitter-c / tree-sitter-cpp | MIT |
| tree-sitter-php | MIT |
| tree-sitter-ruby | MIT |
| tree-sitter-kotlin | MIT |

Сам пакет `tree-sitter-wasms` распространяется под Unlicense.
