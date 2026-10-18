import { DatabaseSync } from "node:sqlite";
import { openEmbCache } from "./embcache";

const [path, id, startAt, puts] = process.argv.slice(2) as [string, string, string, string];
const PER_PUT = 32;

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hold(): void {
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  process.send?.("locked");
  setTimeout(() => {
    db.exec("COMMIT");
    db.close();
  }, 300);
}

function write(): void {
  sleepSync(Number(startAt) - Date.now());
  const cache = openEmbCache(path);
  let written = 0;
  for (let i = 0; i < Number(puts); i++) {
    const entries = Array.from({ length: PER_PUT }, (_, j) => ({
      chunkHash: `${id}-${i}-${j}`.padStart(64, "0"),
      vector: new Float32Array([i, j, Number(id)]),
    }));
    cache.put("m", entries);
    cache.get(
      "m",
      entries.map((e) => e.chunkHash),
    );
    written += entries.length;
  }
  cache.close();
  process.send?.({ written });
}

if (id === "hold") hold();
else write();
