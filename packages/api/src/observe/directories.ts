import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function createDirectoryReader(recursive = true) {
  const directories = new Map<string, { stamp: string; children: { path: string; directory: boolean }[] }>();
  return function list(directory: string, matches: (name: string) => boolean): string[] {
    const files: string[] = [];
    function visit(path: string): void {
      let stat;
      try { stat = statSync(path); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") { directories.delete(path); return; }
        throw error;
      }
      const stamp = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let cached = directories.get(path);
      if (cached?.stamp !== stamp) {
        cached = { stamp, children: readdirSync(path, { withFileTypes: true })
          .filter((entry) => recursive && entry.isDirectory() || entry.isFile() && matches(entry.name))
          .map((entry) => ({ path: join(path, entry.name), directory: entry.isDirectory() })) };
        directories.set(path, cached);
      }
      for (const child of cached.children) {
        if (child.directory) visit(child.path);
        else files.push(child.path);
      }
    }
    visit(directory);
    return files.sort();
  };
}
