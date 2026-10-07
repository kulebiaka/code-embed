import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvalMetrics, EvalMode, EvalReport } from "./types";

export interface RunReport extends EvalReport {
  latencyMs?: { p50: number; p95: number };
}

export interface RunResult {
  model: string;
  createdAt: string;
  reports: RunReport[];
  nr10: Nr10 | null;
}

export interface Nr10 {
  hybrid: number;
  lexical: number;
  semantic: number;
  ok: boolean;
}

export interface BenchRow {
  model: string;
  error?: string;
  indexSeconds?: number;
  chunksPerSec?: number;
  rssMb?: number;
  p50?: number;
  p95?: number;
  recall?: number;
  recallRu?: number;
  mrr?: number;
  mrrRu?: number;
}

export function checkNr10(reports: EvalReport[]): Nr10 | null {
  const at = (mode: EvalMode) => reports.find((r) => r.mode === mode)?.overall.recallAt10;
  const hybrid = at("hybrid");
  const lexical = at("lexical");
  const semantic = at("semantic");
  if (hybrid === undefined || lexical === undefined || semantic === undefined) return null;
  return { hybrid, lexical, semantic, ok: hybrid >= Math.max(lexical, semantic) };
}

export function benchRow(model: string, reports: RunReport[]): BenchRow {
  const h = reports.find((r) => r.mode === "hybrid") ?? reports[0];
  if (!h) return { model, error: "no reports" };
  return {
    model,
    indexSeconds: h.indexSeconds,
    chunksPerSec: h.chunksPerSec,
    rssMb: h.rssMb,
    p50: h.latencyMs?.p50,
    p95: h.latencyMs?.p95,
    recall: h.overall.recallAt10,
    recallRu: h.ru.recallAt10,
    mrr: h.overall.mrr,
    mrrRu: h.ru.mrr,
  };
}

const f = (v: number | undefined, digits = 3) => (v === undefined ? "-" : v.toFixed(digits));
const metricCells = (m: EvalMetrics) => `${m.count} | ${f(m.recallAt10)} | ${f(m.mrr)}`;

export function renderMarkdown(result: RunResult): string {
  const lines = [`# Eval: ${result.model}`, "", `Создан: ${result.createdAt}`, ""];
  lines.push("## Метрики по режимам", "");
  lines.push("| Режим | Выборка | Запросов | Recall@10 | MRR |", "|---|---|---|---|---|");
  for (const r of result.reports) {
    lines.push(`| ${r.mode} | все | ${metricCells(r.overall)} |`);
    lines.push(`| ${r.mode} | ru (информационно) | ${metricCells(r.ru)} |`);
    lines.push(`| ${r.mode} | en | ${metricCells(r.en)} |`);
  }
  lines.push("", "## По репозиториям", "");
  lines.push("| Режим | Репозиторий | Запросов | Recall@10 | MRR |", "|---|---|---|---|---|");
  for (const r of result.reports) {
    for (const [repo, m] of Object.entries(r.perRepo)) lines.push(`| ${r.mode} | ${repo} | ${metricCells(m)} |`);
  }
  const timed = result.reports.find((r) => r.indexSeconds !== undefined);
  if (timed) {
    lines.push("", "## Индексация и поиск", "");
    lines.push(`- индексация: ${f(timed.indexSeconds, 1)} с, ${f(timed.chunksPerSec, 1)} чанков/с`);
    lines.push(`- пиковый RSS: ${f(timed.rssMb, 0)} МБ`);
    for (const r of result.reports) {
      if (r.latencyMs) lines.push(`- поиск ${r.mode}: p50 ${f(r.latencyMs.p50, 1)} мс, p95 ${f(r.latencyMs.p95, 1)} мс`);
    }
  }
  lines.push("", "## NR-10", "");
  if (result.nr10) {
    const n = result.nr10;
    lines.push(
      `Recall@10: hybrid ${f(n.hybrid)}, lexical ${f(n.lexical)}, semantic ${f(n.semantic)}.`,
      "",
      n.ok ? "NR-10 выполняется: hybrid >= max(lexical, semantic)." : "NR-10 НЕ выполняется: hybrid < max(lexical, semantic).",
    );
  } else {
    lines.push("Не проверялось: для проверки нужны все три режима.");
  }
  lines.push("", "Русская метрика информационная, порога нет.", "");
  return lines.join("\n");
}

export function renderBenchMarkdown(rows: BenchRow[], createdAt: string): string {
  const lines = [`# Бенчмарк моделей`, "", `Создан: ${createdAt}`, "", "Качество — hybrid-режим.", ""];
  lines.push(
    "| Модель | Индексация, с | Чанков/с | Пик RSS, МБ | p50, мс | p95, мс | Recall@10 | Recall@10 ru | MRR | MRR ru |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of rows) {
    if (r.error) {
      lines.push(`| ${r.model} | ошибка: ${r.error.replace(/\|/g, "/").replace(/\s+/g, " ")} | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${r.model} | ${f(r.indexSeconds, 1)} | ${f(r.chunksPerSec, 1)} | ${f(r.rssMb, 0)} | ${f(r.p50, 1)} | ${f(r.p95, 1)} | ${f(r.recall)} | ${f(r.recallRu)} | ${f(r.mrr)} | ${f(r.mrrRu)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function writeOutputs(dir: string, name: string, json: unknown, markdown: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${name}.json`);
  const mdPath = path.join(dir, `${name}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(mdPath, markdown);
  return { json: jsonPath, md: mdPath };
}
