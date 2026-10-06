import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initHashing } from "../util/hash";
import { dockerignoreWarning, ensureIndexDir, LOCK_FILE, META_FILE } from "./index-dir";
import { acquireLock, isProcessAlive, readLockPid } from "./lock";
import { detectRiskyPath, INDEX_DIR_NAME, resolveIndexDir } from "./location";
import { compareMeta, type IndexMeta, readMeta, SCHEMA_VERSION, writeMeta } from "./meta";
import { cacheDir, configDir, embCachePath, modelsDir, rootHash, socketPath } from "./paths";
import { findProjectRoot } from "./root";

let tmp: string;
const realPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p });
}

beforeAll(async () => {
  await initHashing();
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ce-core-")));
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("prefers nearest .code-embed over git root", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, "pkg", ".code-embed"), { recursive: true });
    mkdirSync(join(tmp, "pkg", "src"));
    expect(findProjectRoot(join(tmp, "pkg", "src"))).toBe(join(tmp, "pkg"));
  });

  it("monorepo subfolder resolves to git root", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, "packages", "a", "src"), { recursive: true });
    expect(findProjectRoot(join(tmp, "packages", "a", "src"))).toBe(tmp);
  });

  it("falls back to cwd", () => {
    mkdirSync(join(tmp, "x"));
    expect(findProjectRoot(join(tmp, "x"))).toBe(join(tmp, "x"));
  });
});

describe("ensureIndexDir", () => {
  it("creates dir and .gitignore, keeps existing", () => {
    const dir = join(tmp, INDEX_DIR_NAME);
    expect(ensureIndexDir(dir)).toEqual({ created: true });
    expect(readFileSync(join(dir, ".gitignore"), "utf8").trim()).toBe("*");
    writeFileSync(join(dir, ".gitignore"), "custom");
    expect(ensureIndexDir(dir)).toEqual({ created: false });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom");
  });
});

describe("meta", () => {
  const meta: IndexMeta = {
    schema_version: SCHEMA_VERSION,
    model_id: "m",
    model_sha: "sha",
    chunker_version: "c1",
    dims: 4,
  };

  it("roundtrips, null when missing or corrupt", () => {
    expect(readMeta(tmp)).toBeNull();
    writeMeta(tmp, meta);
    expect(readMeta(tmp)).toEqual(meta);
    writeFileSync(join(tmp, META_FILE), "{broken");
    expect(readMeta(tmp)).toBeNull();
  });

  it("compareMeta distinguishes differences", () => {
    expect(compareMeta(meta, meta)).toBe("ok");
    expect(compareMeta(null, meta)).toBe("missing");
    expect(compareMeta({ ...meta, schema_version: 0 }, meta)).toBe("schema");
    expect(compareMeta({ ...meta, chunker_version: "c0" }, meta)).toBe("chunker");
    expect(compareMeta({ ...meta, model_id: "other" }, meta)).toBe("model");
    expect(compareMeta({ ...meta, dims: 8 }, meta)).toBe("model");
  });
});

describe("lock", () => {
  it("writes pid, blocks second holder, releases", () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
    try {
      writeFileSync(join(tmp, LOCK_FILE), String(child.pid));
      expect(acquireLock(tmp)).toBeNull();
    } finally {
      child.kill();
    }
    rmSync(join(tmp, LOCK_FILE));
    const h = acquireLock(tmp);
    expect(h?.pid).toBe(process.pid);
    expect(readLockPid(tmp)).toBe(process.pid);
    h?.release();
    expect(readLockPid(tmp)).toBeNull();
  });

  it("takes over a dead holder", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(isProcessAlive(dead)).toBe(false);
    writeFileSync(join(tmp, LOCK_FILE), String(dead));
    const h = acquireLock(tmp);
    expect(h).not.toBeNull();
    expect(readLockPid(tmp)).toBe(process.pid);
    h?.release();
  });

  it("takes over garbage lock content", () => {
    writeFileSync(join(tmp, LOCK_FILE), "junk");
    expect(acquireLock(tmp)).not.toBeNull();
  });
});

describe("detectRiskyPath / resolveIndexDir", () => {
  beforeEach(() => {
    vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  });

  it("detects sync folders", () => {
    expect(detectRiskyPath("/home/u/Dropbox/proj")).toMatch(/Dropbox/);
    expect(detectRiskyPath(`${homedir()}/Library/Mobile Documents/com~apple~CloudDocs/p`)).toMatch(/iCloud/);
    expect(detectRiskyPath("/home/u/OneDrive - Corp/p")).toMatch(/OneDrive/);
    expect(detectRiskyPath("/home/u/code/proj")).toBeNull();
  });

  it("detects ~/Documents on macOS only", () => {
    setPlatform("darwin");
    expect(detectRiskyPath(`${homedir()}/Documents/p`)).toMatch(/Documents/);
    expect(detectRiskyPath(`${homedir()}/code/p`)).toBeNull();
    setPlatform("linux");
    vi.stubEnv("CODE_EMBED_PROC_MOUNTS", join(tmp, "none"));
    expect(detectRiskyPath(`${homedir()}/Documents/p`)).toBeNull();
  });

  it("detects WSL drives", () => {
    setPlatform("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.stubEnv("CODE_EMBED_PROC_MOUNTS", join(tmp, "none"));
    expect(detectRiskyPath("/mnt/c/src/p")).toMatch(/WSL/);
    expect(detectRiskyPath("/home/u/p")).toBeNull();
  });

  it("detects network mounts from /proc/mounts", () => {
    setPlatform("linux");
    const mounts = join(tmp, "mounts");
    writeFileSync(
      mounts,
      "/dev/sda1 / ext4 rw 0 0\nsrv:/export /srv/nfs nfs4 rw 0 0\n//host/share /mnt/my\\040share cifs rw 0 0\n",
    );
    vi.stubEnv("CODE_EMBED_PROC_MOUNTS", mounts);
    vi.stubEnv("WSL_DISTRO_NAME", "");
    expect(detectRiskyPath("/srv/nfs/p")).toMatch(/nfs4/);
    expect(detectRiskyPath("/mnt/my share/p")).toMatch(/cifs/);
    expect(detectRiskyPath("/srv/other")).toBeNull();
  });

  it("resolves location with overrides", () => {
    const root = "/home/u/Dropbox/p";
    const auto = resolveIndexDir(root, "auto");
    expect(auto.inCache).toBe(true);
    expect(auto.dir).toBe(join(tmp, "cache", "indexes", rootHash(root)));
    expect(auto.reason).toBeTruthy();
    expect(resolveIndexDir(root, "project")).toEqual({ dir: join(root, INDEX_DIR_NAME), inCache: false });
    expect(resolveIndexDir("/home/u/code/p", "cache").inCache).toBe(true);
    expect(resolveIndexDir("/home/u/code/p", "auto").inCache).toBe(false);
  });
});

describe("paths", () => {
  it("honours env overrides", () => {
    vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "c"));
    vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "cfg"));
    expect(cacheDir()).toBe(join(tmp, "c"));
    expect(configDir()).toBe(join(tmp, "cfg"));
    expect(modelsDir()).toBe(join(tmp, "c", "models"));
    expect(embCachePath()).toBe(join(tmp, "c", "emb.db"));
  });

  it("falls back to env-paths", () => {
    vi.stubEnv("CODE_EMBED_CACHE_DIR", "");
    vi.stubEnv("CODE_EMBED_CONFIG_DIR", "");
    expect(cacheDir()).toMatch(/code-embed$/);
    expect(configDir()).toMatch(/code-embed$/);
  });

  it("socketPath per platform", () => {
    const h = rootHash("/r");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    vi.stubEnv("TMPDIR", "/tmpx");
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1");
    setPlatform("linux");
    expect(socketPath("/r")).toBe(`/run/user/1/code-embed/${h}.sock`);
    vi.stubEnv("XDG_RUNTIME_DIR", "");
    expect(socketPath("/r")).toBe(`/tmpx/code-embed/${h}.sock`);
    setPlatform("darwin");
    expect(socketPath("/r")).toBe(`/tmpx/code-embed/${h}.sock`);
    setPlatform("win32");
    expect(socketPath("/r")).toBe(`\\\\.\\pipe\\code-embed-${h}`);
  });
});

describe("dockerignoreWarning", () => {
  it("warns only when Dockerfile lacks ignore entry", () => {
    expect(dockerignoreWarning(tmp)).toBeNull();
    writeFileSync(join(tmp, "Dockerfile"), "FROM x");
    expect(dockerignoreWarning(tmp)).toMatch(/\.code-embed/);
    writeFileSync(join(tmp, ".dockerignore"), "node_modules\n");
    expect(dockerignoreWarning(tmp)).not.toBeNull();
    writeFileSync(join(tmp, ".dockerignore"), "node_modules\n.code-embed\n");
    expect(dockerignoreWarning(tmp)).toBeNull();
  });
});
