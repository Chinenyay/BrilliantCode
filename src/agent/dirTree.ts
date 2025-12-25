import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Render a concise tree of the active workspace. The tree is included in the
// system prompt so the LLM understands the project layout without requesting
// additional tool calls. Output lines are pre-indented so the renderer can
// display the structure as-is.

export type ListDirTreeOptions = {
  threshold: number;
  includeHidden: boolean;
  countFilesOnly: boolean;
  sortEntries: boolean;
};

export async function listDirTree(
  root: string,
  opts?: Partial<ListDirTreeOptions>
): Promise<string[]> {
  const options: ListDirTreeOptions = {
    threshold: opts?.threshold ?? 20,
    includeHidden: opts?.includeHidden ?? false,
    countFilesOnly: opts?.countFilesOnly ?? false,
    sortEntries: opts?.sortEntries ?? true,
  };

  const lines: string[] = [];
  let stat: import('fs').Stats | null = null;

  try {
    stat = await fs.stat(root);
  } catch {
    throw new Error(`Path does not exist: ${root}`);
  }

  const top = path.resolve(root) + (stat.isDirectory() ? '/' : '');
  lines.push(top);

  const visible = (name: string) =>
    options.includeHidden || !name.startsWith('.');

  type ScanResult =
    | { entries: { name: string; full: string; isDir: boolean }[]; countForThreshold: number; err?: undefined }
    | { entries?: undefined; countForThreshold?: undefined; err: string };

  const scanChildren = async (dir: string): Promise<ScanResult> => {
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      let entries = dirents
        .filter(d => visible(d.name))
        .map(d => {
          const full = path.join(dir, d.name);
          return { name: d.name, full, isDir: d.isDirectory() };
        });

      if (options.sortEntries) {
        entries.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
      }

      const countForThreshold = options.countFilesOnly
        ? entries.filter(e => !e.isDir).length
        : entries.length;

      return { entries, countForThreshold };
    } catch (e: any) {
      const msg = e?.code === 'EACCES' ? 'permission denied' : `oserror: ${e?.message || e}`;
      return { err: msg };
    }
  };

  // Depth-first traversal with a threshold guard so prompts stay small when
  // directories explode (e.g., node_modules).
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const res = await scanChildren(dir);
    if ('err' in res) {
      lines.push(prefix + `[${res.err}]`);
      return;
    }
    const { entries, countForThreshold } = res;
    if (countForThreshold > options.threshold) {
      lines.push(prefix + '**');
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const child = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const name = child.name + (child.isDir ? '/' : '');
      lines.push(prefix + connector + name);
      if (child.isDir) {
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');
        await walk(child.full, nextPrefix);
      }
    }
  };

  if (stat.isDirectory()) {
    await walk(path.resolve(root), '');
  }

  return lines;
}
