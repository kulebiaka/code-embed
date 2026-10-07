# CLI

`code-embed` (npm-пакет `code-embed`). Справка: `code-embed --help`, версия: `code-embed --version`. stdout занят результатами, логи и подсказки идут в stderr.

## Коды выхода

| Код | Значение |
| --- | --- |
| 0 | успех |
| 1 | поиск выполнен, результатов нет |
| 2 | ошибка (неверные аргументы, отказ от подтверждения и т. п.) |

## Поиск

```
code-embed [OPTIONS] <QUERY>
```

| Опция | Описание |
| --- | --- |
| `-s`, `--semantic` | только семантический поиск |
| `-l`, `--lexical` | только лексический поиск |
| `-H`, `--hybrid` | гибридный поиск (по умолчанию) |
| `-n`, `--top N` | число результатов |
| `-g`, `--glob PATTERN` | маска пути, повторяемая; `!` в начале исключает |
| `--lang LANG` | ограничить языком |
| `--threshold X` | минимальная оценка |
| `-C`, `--context N` | строк контекста вокруг совпадения |
| `--files-only` | вывести только уникальные пути |
| `--json` | вывод JSON lines (общий контракт с инструментом `search`) |
| `--no-update` | не обновлять индекс перед поиском |
| `--root DIR` | корень проекта |
| `--color WHEN` | `auto`, `always`, `never` |
| `--provider NAME` | провайдер эмбеддингов |
| `--model ID` | модель эмбеддингов |
| `--allow-remote` | разрешить отправку кода внешнему провайдеру |
| `-h`, `--help` | справка |
| `-V`, `--version` | версия |

## similar

```
code-embed similar <PATH>:<START>-<END> [OPTIONS]
code-embed similar - [--lang ts] [OPTIONS]
```

Первая форма ищет код, похожий на диапазон строк (1-based, включительно); вторая читает фрагмент из stdin, `--lang` задаёт язык. Принимает общие опции поиска.

## index

```
code-embed index [--watch] [--full]
```

Строит или обновляет индекс (лексическая фаза, затем векторная). `--watch` продолжает следить за изменениями, `--full` пересобирает с нуля. Прогресс выводится в stderr.

## status

`code-embed status` показывает состояние индекса и движка проекта.

## daemon

`code-embed daemon [--detach]` запускает долгоживущий движок с сокетом и watcher для проекта; `--detach` отвязывает процесс от терминала.

## stop

`code-embed stop` останавливает демон проекта.

## mcp

`code-embed mcp [--root DIR]` запускает stdio MCP-сервер с инструментами `search` и `find_similar`. См. [agents.md](agents.md).

## model

```
code-embed model install [--from FILE]
code-embed model list
```

`model install` без `--from` скачивает выбранную (или модель по умолчанию) по манифесту с проверкой sha256; с `--from` устанавливает из оффлайн-архива. `model list` печатает каталог и статус установки.

## provider

```
code-embed provider list
code-embed provider add [--kind openai --base-url URL --model NAME --api-key-env VAR]
code-embed provider test <name>
```

`add` в TTY задаёт вопросы интерактивно; без TTY параметры берутся из флагов `--kind`, `--base-url`, `--model`, `--api-key-env` (дополнительно `--dimensions`, `--max-input-tokens`, `--query-prefix`, `--doc-prefix`). `list` показывает, какие провайдеры внешние. `test` проверяет доступность провайдера. Конфигурация: [configuration.md](configuration.md).

## gc

`code-embed gc` удаляет из глобального кеша эмбеддингов записи, которые больше не нужны индексам.

## clean

`code-embed clean [--yes] [--root DIR]` удаляет индекс проекта. Без `--yes` в TTY спрашивает подтверждение, без TTY отказывается (код 2). Если для проекта запущен демон, сначала выполните `code-embed stop`.

## export

`code-embed export [--out FILE]` сохраняет индекс проекта в архив для переноса.

## import

`code-embed import <FILE>` загружает индекс из архива, созданного `export`.

## Внешние провайдеры и подтверждение

При первой отправке кода внешнему провайдеру CLI спрашивает подтверждение (интерактивно в TTY). Без TTY команда завершится кодом 2 с подсказкой; передайте `--allow-remote`, чтобы разрешить. Подтверждение сохраняется в `consents.toml`.
