import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, runCheck, type CheckResult, type RuntimeReport } from "./report";

type Mod = any;

const enginePkg = process.env.STAGE0_ENGINE_PKG ?? fileURLToPath(new URL("../../packages/engine/package.json", import.meta.url));
const req = createRequire(enginePkg);

function blob(v: number[]): Uint8Array {
  const i8 = Int8Array.from(v);
  return new Uint8Array(i8.buffer, i8.byteOffset, i8.byteLength);
}

async function sqliteChecks(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  let sqlite: Mod;
  out.push(
    await runCheck("node:sqlite", true, async () => {
      sqlite = await import("node:sqlite");
      if (typeof sqlite.DatabaseSync !== "function") throw new Error("DatabaseSync missing");
      const db = new sqlite.DatabaseSync(":memory:");
      const v = db.prepare("select sqlite_version() as v").get() as { v: string };
      db.close();
      return { sqliteVersion: v.v };
    }),
  );
  out.push(
    await runCheck("sqlite-vec:load", true, () => {
      const db = new sqlite.DatabaseSync(":memory:", { allowExtension: true });
      try {
        db.loadExtension(req("sqlite-vec").getLoadablePath());
        const v = db.prepare("select vec_version() as v").get() as { v: string };
        return { vecVersion: v.v };
      } finally {
        db.close();
      }
    }),
  );
  out.push(
    await runCheck("fts5:unicode61", true, () => {
      const db = new sqlite.DatabaseSync(":memory:");
      try {
        db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='unicode61')");
        db.prepare("INSERT INTO t(rowid, text) VALUES (?, ?)").run(1n, "process payment refund");
        const rows = db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all("refund") as unknown[];
        if (rows.length !== 1) throw new Error(`fts5 match returned ${rows.length} rows`);
      } finally {
        db.close();
      }
    }),
  );
  out.push(
    await runCheck("vec0:int8-knn", true, () => {
      const db = new sqlite.DatabaseSync(":memory:", { allowExtension: true });
      try {
        db.loadExtension(req("sqlite-vec").getLoadablePath());
        db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding int8[4])");
        const ins = db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, vec_int8(?))");
        ins.run(1n, blob([127, 0, 0, 0]));
        ins.run(2n, blob([0, 127, 0, 0]));
        ins.run(3n, blob([100, 20, 0, 0]));
        const rows = db
          .prepare("SELECT rowid FROM v WHERE embedding MATCH vec_int8(?) AND k = 2 ORDER BY distance")
          .all(blob([127, 1, 0, 0])) as { rowid: number }[];
        const ids = rows.map((r) => Number(r.rowid));
        if (ids.join() !== "1,3") throw new Error(`unexpected kNN order: ${ids.join()}`);
        return { nearest: ids };
      } finally {
        db.close();
      }
    }),
  );
  return out;
}

async function nativeChecks(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  out.push(
    await runCheck("onnxruntime-node", true, () => {
      const ort = req("onnxruntime-node");
      const backends = ort.listSupportedBackends().map((b: { name: string }) => b.name);
      if (!backends.includes("cpu")) throw new Error(`no cpu backend: ${backends.join()}`);
      return { backends };
    }),
  );
  out.push(
    await runCheck("@parcel/watcher", true, async () => {
      const watcher = req("@parcel/watcher");
      const dir = mkdtempSync(join(tmpdir(), "code-embed-stage0-"));
      try {
        const sub = await watcher.subscribe(dir, () => {});
        writeFileSync(join(dir, "probe.txt"), "x");
        await sub.unsubscribe();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
  out.push(
    await runCheck("@napi-rs/keyring", false, () => {
      const { Entry } = req("@napi-rs/keyring");
      const entry = new Entry("code-embed-stage0", "probe");
      entry.getPassword();
    }),
  );
  out.push(
    await runCheck("web-tree-sitter", true, async () => {
      const { Parser, Language } = req("web-tree-sitter");
      await Parser.init();
      const lang = await Language.load(req.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm"));
      const parser = new Parser();
      parser.setLanguage(lang);
      const tree = parser.parse("const a = 1;");
      const type = tree.rootNode.type;
      if (type !== "program") throw new Error(`unexpected root node ${type}`);
      return { root: type };
    }),
  );
  out.push(
    await runCheck("hash-wasm", true, async () => {
      const { sha256 } = req("hash-wasm");
      const h = await sha256("abc");
      if (!h.startsWith("ba7816bf")) throw new Error(`unexpected sha256 ${h}`);
    }),
  );
  return out;
}

export async function runChecks(): Promise<RuntimeReport> {
  const checks = [...(await sqliteChecks()), ...(await nativeChecks())];
  return aggregate(
    {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      abi: process.versions.modules,
    },
    checks,
  );
}
