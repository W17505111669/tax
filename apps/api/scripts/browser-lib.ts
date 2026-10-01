/**
 * 浏览器实测的共用底座：找本机 ms-playwright 缓存里的 Chromium 并启动。
 *
 * 为什么要抽出来：`scan:uimd`（界面 Markdown 原文扫描）与交付物实测（真下载一次 bundle /
 * CSV / 台账 MD / mermaid 图片）都要开浏览器。findChromium 原先只写在 scan 脚本里，第二个
 * 脚本要么抄一遍（本机缓存路径与 headless shell 的坑迟早漂），要么 import 一个顶层就会执行
 * 的脚本（会顺带跑一遍扫描）。抽到这里两边共用，前端地址也只写一份。
 *
 * 依赖：playwright-core（不下载浏览器，复用本机 ms-playwright 缓存里的 Chromium）。
 */
import { chromium, type Browser } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 前端地址：5174 是钉死的（5173 被别的项目占用） */
export const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5174";

/** 找本机 ms-playwright 缓存里的 Chromium。 */
export function findChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean) as string[];
  // headless shell 优先：完整版 chrome.exe 在同目录 chrome.dll 缺失时会以
  // 「Failed to load Chrome DLL」启动失败——本机缓存正是这种情况，实测踩过，故校验依赖文件。
  const CANDIDATES: Array<[string, string | undefined]> = [
    [path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe"), undefined],
    [path.join("chrome-headless-shell-linux", "chrome-headless-shell"), undefined],
    [path.join("chrome-headless-shell-mac", "chrome-headless-shell"), undefined],
    [path.join("chrome-win64", "chrome.exe"), path.join("chrome-win64", "chrome.dll")],
    [path.join("chrome-win", "chrome.exe"), path.join("chrome-win", "chrome.dll")],
    [path.join("chrome-linux", "chrome"), undefined],
    [path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"), undefined],
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // 目录名两种写法都出现过：chromium-1223 与 chromium_headless_shell-1223（下划线），
    // 早先按 /^chromium(-headless-shell)?-\d+$/ 匹配把后者漏掉，直接判定「找不到浏览器」。
    const dirs = fs
      .readdirSync(root)
      .filter((d) => /^chromium/i.test(d) && fs.statSync(path.join(root, d)).isDirectory())
      .sort();
    for (const d of dirs) {
      for (const [rel, needs] of CANDIDATES) {
        const p = path.join(root, d, rel);
        if (!fs.existsSync(p)) continue;
        if (needs && !fs.existsSync(path.join(root, d, needs))) continue;
        return p;
      }
    }
  }
  return undefined;
}

/** 启动 headless Chromium；找不到本机缓存时如实退出（退出码 2，与 scan:uimd 一致） */
export async function launchChromium(): Promise<Browser> {
  const exe = findChromium();
  if (!exe) {
    console.log("[FAIL] 找不到本机 Chromium 缓存（ms-playwright），无法实测");
    process.exit(2);
  }
  return chromium.launch({ executablePath: exe, headless: true });
}
