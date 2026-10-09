# Этап 0: проверка рантайма

Проверяет, что нативные и WASM-зависимости движка загружаются в текущем рантайме.

```bash
pnpm stage0                                                  # системный Node
pnpm --filter @code-embed/eval exec tsx stage0/check-electron.ts   # Electron из VS Code (min из engines.vscode и stable)
```

На Linux без дисплея: `xvfb-run -a pnpm --filter @code-embed/eval exec tsx stage0/check-electron.ts`.
CI: `.github/workflows/native-smoke.yml` (workflow_dispatch, теги `v*`, изменения package.json/lock).

Отчёты — JSON в `eval/stage0/reports/` (или `STAGE0_REPORT_DIR`): `runtime-<platform>-<arch>.json`,
`electron-<версия>-<platform>-<arch>.json`. Код выхода ненулевой, если упала обязательная проверка.

## Как читать отчёт

- `ok` — все обязательные проверки прошли; `failedRequired` — имена упавших обязательных; `warnings` — упавшие необязательные.
- `checks[].status`: `pass` / `fail` (обязательная) / `warn` (необязательная); `detail` и `error` поясняют результат.
- Обязательные: `node:sqlite`, `sqlite-vec:load` (`DatabaseSync({allowExtension:true})` + `loadExtension`),
  `fts5:unicode61`, `vec0:int8-knn`, `onnxruntime-node`, `@parcel/watcher`, `web-tree-sitter`, `hash-wasm`.
- Необязательная: `@napi-rs/keyring` (на headless Linux нет secret service — это предупреждение, не отказ).
- В отчёте Electron поля `electron` и `node` показывают версию Electron и его встроенного Node.

## Правило решения (R-128, Q-28)

Если `node:sqlite` или `allowExtension`/`loadExtension` не работает хотя бы в одном рантайме
(системный Node >= 22.13 или Electron из целевой версии VS Code) на любом таргете, хранилище
переключается на `better-sqlite3` >= 13 за тем же интерфейсом хранилища (R-05); минимальная версия Node
тогда понижается до 20. Иначе фиксируется минимальная версия Node из таблицы ниже.

## Результаты по таргетам (заполняет человек)

| Таргет | Node (версия) | node:sqlite + vec + FTS5 | Electron min VS Code (Electron / Node) | Electron stable (Electron / Node) | onnx / watcher / tree-sitter / hash-wasm | keyring |
| --- | --- | --- | --- | --- | --- | --- |
| win32-x64 | | | | | | |
| win32-arm64 | | | | | | |
| darwin-x64 | | | | | | |
| darwin-arm64 | | | | | | |
| linux-x64 | | | | | | |
| linux-arm64 | | | | | | |

Решение по Q-28 (минимальная версия Node, рантайм SQLite): _заполнить после прогона_.

## Smoke реальной модели под Electron VS Code (R-123, NR-08)

Opt-in регрессия: упакованный движок из VSIX запускается исполняемым файлом VS Code (macOS: `Code Helper (Plugin)`) с `ELECTRON_RUN_AS_NODE=1`, как в расширении, индексирует фикстуру с настоящей моделью. Быстрые тесты работают с фейковым эмбеддером и этого не покрывают.

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts \
  [--model <id[,id…]>]        # по умолчанию qwen3-embedding-0.6b
  [--vscode <ver[,ver…]>]     # по умолчанию stable; "min" = минимальная из engines.vscode
  [--engine <path/to/cli.js>] # по умолчанию: собрать VSIX под хост и распаковать
  [--repo <dir>]              # по умолчанию: стресс-фикстура (stress-fixture.ts)
  [--minutes <n>]             # окно наблюдения, по умолчанию 5
  [--min-embedded <n>]        # по умолчанию 300
```

Окружение: `REAL_MODEL_REPORT_DIR` (по умолчанию `eval/reports/real-model`), `CODE_EMBED_MODELS_DIR` (общий каталог моделей; по умолчанию кеш движка), `VSCODE_TEST_CACHE` (кеш VS Code, по умолчанию `$TMPDIR/code-embed-vscode-test`). Каждый прогон использует временные `CODE_EMBED_CACHE_DIR` (с ссылкой `models` на общий каталог и пустым `emb.db`) и `CODE_EMBED_CONFIG_DIR`. Если установленный VS Code не запускается (например, битая подпись), он скачивается заново. Код выхода 0, если все проверки всех комбинаций модель × версия зелёные.

Наблюдение идёт до `embedded === chunks` или конца окна (время загрузки модели в окно не входит). Пробы: RSS дерева процессов (`ps`, каждые 250 мс; на Windows пропускается), `status` (1 с), лексический поиск (2 с), гибридный (5 с, когда есть векторы), `findSimilar` (10 с), NR-07 (однократно, ≥ 20 с после первых векторов).

| Проверка | Порог |
| --- | --- |
| `no-crash` | нет выхода движка до `shutdown`; в ошибках нет `inference process exited`, `SIGTRAP`, `SIGABRT`, `SIGSEGV` |
| `progress` | `embedded ≥ min(--min-embedded, chunks)` |
| `rss` | пик суммы дерева: 2560 МБ для `qwen3-embedding-0.6b`, 1024 МБ для `bge-m3`, 1024 МБ для остальных (моделей ≤ 300M; временное утверждённое пользователем отступление от NR-08 с 700 МБ) |
| `status-p95`, `lexical-p95` | ≤ 200 мс |
| `nr07` | ≤ 1000 мс от записи файла до появления идентификатора в лексическом поиске |
| `hybrid-during-indexing`, `find-similar-during-indexing` | p95 и max ≤ 1300 мс; ответ дольше 800 мс обязан быть `partial: true` с `timed out` |
| `shutdown` | выход ≤ 10 с, потомков не осталось |
| `stress-indexed` | файлы `stress/*` найдены лексическим поиском (только для стресс-фикстуры) |

Пороги заданы константами в `real-model-report.ts`; ослаблять их при красном результате нельзя, это дефект продукта.

### Как читать отчёт

Файл `real-model-<model>-<vscode>-<platform>-<arch>.json` и рядом `….engine.log` (stderr движка).

- `rssMb`: `peakTree` (сумма), `peakEngine` (основной процесс), `peakInference` (`__embed-worker`), `enginePeakPhase` (фаза, на которой основной процесс достиг пика).
- `fixture`: файлы, чанки, размер `index.db`; `embedded`, `chunksPerSec`.
- `latency`: перцентили `status` и лексического поиска; для гибридного и `findSimilar` во время индексации ещё `semanticShare` (доля ответов с семантикой) и `timedOutShare` (доля ответов по таймауту).
- `checks[]`: вердикт по каждой проверке (`pass` / `fail` / `skip`) с подробностью; `ok` равен нулю провалов.
- `timeline`: ход индексации; `errors`: все `index.error` и `status.lastError`.

CI: джоба `real-model` в `native-smoke.yml` (macos-14, ubuntu-22.04, windows-2022).

