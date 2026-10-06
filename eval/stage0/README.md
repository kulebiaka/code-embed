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
