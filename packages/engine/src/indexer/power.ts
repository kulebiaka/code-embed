import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export function parsePmset(out: string): boolean {
  return /Now drawing from 'Battery Power'/i.test(out);
}

// Win32_Battery.BatteryStatus: 1 = discharging
export function parseWindowsBattery(out: string): boolean {
  return out.trim() === "1";
}

async function linuxOnBattery(): Promise<boolean> {
  const base = "/sys/class/power_supply";
  let anyBattery = false;
  for (const name of await readdir(base)) {
    const type = (await readFile(`${base}/${name}/type`, "utf8").catch(() => "")).trim();
    if (type === "Mains") {
      const online = (await readFile(`${base}/${name}/online`, "utf8").catch(() => "")).trim();
      if (online === "1") return false;
    } else if (type === "Battery") {
      anyBattery = true;
    }
  }
  return anyBattery;
}

export async function isOnBattery(
  platform: NodeJS.Platform = process.platform,
  exec: Exec = defaultExec,
): Promise<boolean> {
  try {
    if (platform === "darwin") return parsePmset(await exec("pmset", ["-g", "batt"]));
    if (platform === "linux") return await linuxOnBattery();
    if (platform === "win32") {
      const out = await exec("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1).BatteryStatus",
      ]);
      return parseWindowsBattery(out);
    }
  } catch {}
  return false;
}
