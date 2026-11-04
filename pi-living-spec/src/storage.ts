import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Archive } from "./schema.js";

export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export function noSymlinks(path: string): void {
  let p = resolve(path);
  for (;;) {
    if (existsSync(p) || (() => { try { lstatSync(p); return true; } catch { return false; } })()) {
      if (lstatSync(p).isSymbolicLink()) throw new Error(`Symlink not allowed: ${p}`);
    }
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
}
export function inside(root: string, name: string): string {
  if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error(`Unsafe relative path: ${name}`);
  const p = resolve(root, name);
  if (p !== resolve(root) && !p.startsWith(resolve(root) + sep)) throw new Error("Path escapes root");
  noSymlinks(p);
  return p;
}
export function atomicWrite(path: string, bytes: string | Buffer): void {
  noSymlinks(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp-" + randomUUID();
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function locked<T>(path: string, fn: () => T): T {
  noSymlinks(path);
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch { throw new Error(`Workspace busy or stale lock: ${path}. Retry. After a crash, verify no writer is running before removing the lock.`); }
  try { return fn(); } finally { closeSync(fd); unlinkSync(path); }
}
const allowed = /^(?:crawl\/(?:screens\/[^/]+\.(?:png|jpe?g|webp)|pages\/[^/]+\.md|api-inventory\.md)|screens\/[^/]+\.(?:png|jpe?g|webp)|source-map\.md|assets\/[^/]+\.(?:png|jpe?g|webp|md|txt))$/i;
export function archiveReference(root: string, reference: string, publishApproved = false): Archive {
  if (!publishApproved) return { reference, availability: "unavailable", reason: "Not approved for publication. Not packaged" };
  if (/^https?:\/\//i.test(reference)) return { reference, availability: "external", reason: "External content is not frozen" };
  let rel = reference.replace(/^\.living-spec\//, "");
  if (isAbsolute(reference)) rel = relative(root, reference);
  if (!allowed.test(rel)) return { reference, availability: "unavailable", reason: "Not an allowlisted capture. Routes and source references remain citations only" };
  try {
    const p = inside(root, rel);
    if (!lstatSync(p).isFile()) throw new Error("Not a regular file");
    const data = readFileSync(p);
    const hash = digest(data), extension = extname(p).toLowerCase();
    const target = inside(root, `evidence/${hash}${extension}`);
    if (existsSync(target)) { if (digest(readFileSync(target)) !== hash) throw new Error("Archived evidence digest mismatch"); }
    else atomicWrite(target, data);
    return { reference, availability: "archived", hash, extension };
  } catch (e) { return { reference, availability: "unavailable", reason: (e as Error).message }; }
}
export function archivedBytes(root: string, archive: Archive): Buffer | undefined {
  if (archive.availability !== "archived") return undefined;
  if (!/^[a-f0-9]{64}$/.test(archive.hash ?? "") || !/^\.(png|jpg|jpeg|webp|md|txt)$/.test(archive.extension ?? "")) throw new Error("Invalid evidence archive path");
  const p = inside(root, `evidence/${archive.hash}${archive.extension}`);
  if (!existsSync(p)) return undefined;
  const data = readFileSync(p);
  if (digest(data) !== archive.hash) throw new Error("Evidence archive digest mismatch");
  return data;
}
