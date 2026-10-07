import { getPreferenceValues, showHUD, showToast, Toast } from "@raycast/api";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// The app writes its own path to %LOCALAPPDATA%\SakugaTV\app-path.txt every time it starts,
// so after the first manual launch this command finds it with no setup.
function appPath(): string | undefined {
  const { appPath } = getPreferenceValues<Preferences.Abrir>();
  if (appPath && existsSync(appPath)) return appPath;
  const saved = join(process.env.LOCALAPPDATA || "", "SakugaTV", "app-path.txt");
  if (existsSync(saved)) {
    const p = readFileSync(saved, "utf8").trim();
    if (existsSync(p)) return p;
  }
  return undefined;
}

export default async function main() {
  const app = appPath();
  if (!app) {
    await showToast({
      style: Toast.Style.Failure,
      title: "SakugaTV app not found",
      message: "Open sakugatv.exe once, or set its path in the extension preferences.",
    });
    return;
  }
  // Raycast kills child processes when the command ends; launching through `start` survives
  spawn("cmd.exe", ["/d", "/s", "/c", `"start "" "${app}""`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
  await showHUD("Opening SakugaTV");
}
