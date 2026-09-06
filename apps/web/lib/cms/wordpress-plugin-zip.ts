// ---------------------------------------------------------------------------
// altorank.zip, built from packages/wordpress-plugin on demand
// ---------------------------------------------------------------------------
//
// The connect dialog's "Recommended" WordPress path used to deep-link to a
// wordpress.org search for `altorank` - a directory the plugin is not listed
// in - so the person following the dialog landed on "No plugins found" and
// stopped there. Until the listing exists, the app serves the zip itself and
// the dialog points at the customer's own Plugins -> Add New -> Upload page.
//
// The archive is written here rather than by bin/build-zip.sh so that the
// file a customer downloads is always built from the plugin source that ships
// with this version of the app; a zip committed beside it would drift the
// first time includes/api.php changed. Node has no zip writer, and the format
// is small enough not to want a dependency: a local header per file, a central
// directory, an end record. Entries are DEFLATE'd with node:zlib.
//
// Server-only: reads the filesystem.

import { promises as fs } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

/** Directory name WordPress expects at the top of the archive. */
export const PLUGIN_SLUG = "altorank";
export const PLUGIN_ZIP_FILENAME = `${PLUGIN_SLUG}.zip`;

/**
 * Where the plugin source lives, relative to the process's working directory.
 * `next dev` and `next build` run from apps/web; the Docker image and a
 * checkout-root invocation run from the repository root. Both are tried.
 */
const SOURCE_CANDIDATES = [
  path.join("..", "..", "packages", "wordpress-plugin", PLUGIN_SLUG),
  path.join("packages", "wordpress-plugin", PLUGIN_SLUG),
];

/** Files never worth shipping to a customer's server. */
const EXCLUDED = new Set([".DS_Store", "Thumbs.db"]);

export async function findPluginSourceDir(cwd = process.cwd()): Promise<string | null> {
  for (const candidate of SOURCE_CANDIDATES) {
    const dir = path.resolve(cwd, candidate);
    try {
      const main = await fs.stat(path.join(dir, `${PLUGIN_SLUG}.php`));
      if (main.isFile()) return dir;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The `Version:` header of the plugin's main file, or null when unreadable. */
export async function readPluginVersion(dir: string): Promise<string | null> {
  try {
    const head = await fs.readFile(path.join(dir, `${PLUGIN_SLUG}.php`), "utf8");
    return /^\s*\*\s*Version:\s*(\S+)/m.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

// --- zip container ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields, which is all the zip format has room for. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export type ZipEntry = {
  /** Forward-slash path inside the archive; a trailing slash marks a directory. */
  name: string;
  data: Uint8Array;
  mtime: Date;
};

const STORE = 0;
const DEFLATE = 8;
/** Bit 11: the name is UTF-8. Ours are ASCII, but saying so costs nothing. */
const FLAG_UTF8 = 0x0800;

/**
 * Serialise entries into one zip archive. Deterministic for the same input:
 * no comments, no extra fields, entries in the order given.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const name = Buffer.from(entry.name, "utf8");
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data);
    const deflated = isDir ? raw : deflateRawSync(raw, { level: 9 });
    // Keep a file stored when deflate would only make it bigger (tiny files).
    const method = !isDir && deflated.length < raw.length ? DEFLATE : STORE;
    const body = method === DEFLATE ? deflated : raw;
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    // External attrs: unix mode in the high 16 bits (0755 dir / 0644 file),
    // MS-DOS directory bit in the low byte. WordPress's unzip reads the latter.
    cd.writeUInt32LE(isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);

    locals.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...central, end]);
}

/**
 * Every file under `dir`, as entries rooted at `altorank/`, directories first
 * and everything in path order so two builds of the same tree are identical.
 */
export async function collectPluginEntries(dir: string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  async function walk(rel: string) {
    const abs = path.join(dir, rel);
    const names = (await fs.readdir(abs, { withFileTypes: true }))
      .filter((d) => !EXCLUDED.has(d.name) && !d.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const d of names) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(dir, childRel);
      const stat = await fs.stat(childAbs);
      if (d.isDirectory()) {
        entries.push({ name: `${PLUGIN_SLUG}/${childRel}/`, data: new Uint8Array(0), mtime: stat.mtime });
        await walk(childRel);
      } else if (d.isFile()) {
        entries.push({ name: `${PLUGIN_SLUG}/${childRel}`, data: await fs.readFile(childAbs), mtime: stat.mtime });
      }
    }
  }
  const root = await fs.stat(dir);
  entries.push({ name: `${PLUGIN_SLUG}/`, data: new Uint8Array(0), mtime: root.mtime });
  await walk("");
  return entries;
}

export type PluginZip = { bytes: Buffer; version: string | null };

/** Build the archive from the plugin source directory. */
export async function buildPluginZip(dir: string): Promise<PluginZip> {
  const [entries, version] = await Promise.all([collectPluginEntries(dir), readPluginVersion(dir)]);
  return { bytes: buildZip(entries), version };
}

let cached: Promise<PluginZip> | null = null;

/**
 * The archive for this deployment, built once per process. The source does
 * not change under a running server, so there is nothing to invalidate on;
 * a failed build is not cached, so a fixed checkout is picked up next request.
 */
export function getPluginZip(): Promise<PluginZip> {
  if (!cached) {
    cached = (async () => {
      const dir = await findPluginSourceDir();
      if (!dir) {
        throw new Error(
          `WordPress plugin source not found (looked for ${SOURCE_CANDIDATES.join(", ")} from ${process.cwd()}). ` +
            "The app must be built from a checkout that includes packages/wordpress-plugin.",
        );
      }
      return buildPluginZip(dir);
    })().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
