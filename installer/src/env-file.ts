import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

export type EnvMap = Record<string, string>;

/** Minimal .env parser (KEY=VALUE, `#` comments, optional quotes). */
export function parseEnv(content: string): EnvMap {
  const out: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(path: string): EnvMap {
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Values containing special characters must be quoted. */
export function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_@%+:,./=~-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface EnvSection {
  title: string;
  entries: Array<[key: string, value: string, comment?: string]>;
}

export function renderEnvFile(header: string[], sections: EnvSection[]): string {
  const lines: string[] = [];
  for (const line of header) lines.push(`# ${line}`);
  for (const section of sections) {
    const entries = section.entries.filter(([, value]) => value !== undefined);
    if (entries.length === 0) continue;
    lines.push("");
    lines.push(`# ─── ${section.title} ${"─".repeat(Math.max(0, 60 - section.title.length))}`);
    for (const [key, value, comment] of entries) {
      if (comment) lines.push(`# ${comment}`);
      lines.push(`${key}=${quoteIfNeeded(value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Writes the file with 0600 permissions, backing up any existing file. */
export function writeEnvFile(path: string, content: string, backup = true): string | undefined {
  let backupPath: string | undefined;
  if (backup && existsSync(path)) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return backupPath;
}
