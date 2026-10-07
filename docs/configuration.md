# Конфигурация

## Приоритет

От высшего к низшему: флаги CLI, `.code-embed.toml` проекта, настройки редактора (VS Code `codeEmbed.*`), пользовательский `config.toml`, значения по умолчанию. Исключение: `threads` и `pause_on_battery` не задаются в проектном файле.

Пользовательские файлы (`config.toml`, `providers.toml`, `consents.toml`) лежат в каталоге конфигурации (переопределяется переменной `CODE_EMBED_CONFIG_DIR`). Глобальный кеш (`emb.db`, модели) лежит в каталоге кеша (`CODE_EMBED_CACHE_DIR`).

## .code-embed.toml

Файл в корне проекта. Он локальный и не коммитится: когда инструмент создаёт файл, он добавляет строку `.code-embed.toml` в `.gitignore` проекта, если её там нет.

| Ключ | Значения | По умолчанию |
| --- | --- | --- |
| `exclude` | массив масок путей | `[]` |
| `embedding.provider` | `local` или имя провайдера | `local` |
| `embedding.model` | id модели каталога | `qwen3-embedding-0.6b` |
| `index.location` | `project` или `cache` | автоматически |
| `index.max_file_kb` | число | 512 |
| `search.default_mode` | `hybrid`, `semantic`, `lexical` | `hybrid` |
| `search.top` | число | 20 |

Ключи `base_url`, `api_key`, `api_key_env` в проектном файле запрещены: адреса задаются только в `providers.toml`, ключи не хранятся в файлах.

## providers.toml

```toml
[ollama]
kind = "openai"
base_url = "http://localhost:11434/v1"
model = "nomic-embed-text"
dimensions = 768
batch_size = 32

[remote]
kind = "openai"
base_url = "https://api.example.com/v1"
model = "text-embedding-3-small"
query_prefix = ""
doc_prefix = ""
max_input_tokens = 8191
concurrency = 4
api_key_env = "EXAMPLE_API_KEY"
rpm = 3000
tpm = 1000000
```

Поля: `kind` (сейчас только `openai`), `base_url`, `model` (обязательные), `query_prefix`, `doc_prefix`, `max_input_tokens`, `batch_size`, `concurrency`, `dimensions`, `api_key_env`, `rpm`, `tpm`. Ключ API не пишется в файл: укажите имя переменной окружения в `api_key_env`.

Тот же формат (без ключей) принимает настройка VS Code `codeEmbed.providers`; при совпадении имён она переопределяет `providers.toml`.

Идентификатор модели в индексе: `<provider>/<model>@<dims>`.

## Локальные и внешние провайдеры

- Loopback (`localhost`, `127.0.0.1`, `::1`) и unix socket: локальный провайдер, без предупреждений.
- Любой другой адрес: внешний. Перед первой отправкой кода нужно явное подтверждение для проекта («код будет отправлен на `<host>`»). Подтверждение хранится в `consents.toml`, общем для CLI и расширения. В CLI: интерактивный вопрос или `--allow-remote`.

## Настройки VS Code

| Настройка | Тип | По умолчанию | Описание |
| --- | --- | --- | --- |
| `codeEmbed.index.location` | `auto` / `project` / `cache` | `auto` | где хранить индекс; `auto` уходит в кеш на рискованных файловых системах (сетевые диски, облачная синхронизация) |
| `codeEmbed.index.maxFileKb` | число | 512 | файлы больше не индексируются |
| `codeEmbed.index.threads` | целое | 0 | потоки локальной модели (0 = автоматически) |
| `codeEmbed.index.pauseOnBattery` | булево | false | приостанавливать векторную фазу на батарее |
| `codeEmbed.search.defaultMode` | `hybrid` / `semantic` / `lexical` | `hybrid` | режим поиска по умолчанию |
| `codeEmbed.search.top` | целое | 20 | число результатов |
| `codeEmbed.model.id` | строка | `qwen3-embedding-0.6b` | локальная модель из каталога |
| `codeEmbed.model.offlineArchive` | строка | пусто | путь к оффлайн-архиву модели |
| `codeEmbed.providers` | объект | `{}` | провайдеры: имя → конфигурация (без ключей) |
| `codeEmbed.embedding.provider` | строка | `local` | `local` или имя провайдера |
