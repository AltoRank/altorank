import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  buildPluginZip,
  buildZip,
  collectPluginEntries,
  crc32,
  findPluginSourceDir,
  readPluginVersion,
} from "../wordpress-plugin-zip";
import { GET } from "@/app/api/public/wordpress-plugin/route";

// A minimal reader, so the test checks the archive the way an unzip would:
// find the end record, walk the central directory, inflate each entry, and
// compare the CRC the header claims with the CRC of what came out.
type Read = { name: string; data: Buffer; method: number; isDir: boolean };

function readZip(buf: Buffer): Read[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Read[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== usize) throw new Error(`${name}: size ${data.length} != ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: crc mismatch`);
    out.push({ name, data, method, isDir: (external & 0x10) !== 0 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("crc32", () => {
  it("matches the reference value for a known string", () => {
    // The check value from the CRC-32 specification.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("buildZip", () => {
  it("round-trips files and directories through a central-directory read", () => {
    const big = Buffer.from("<?php\n".repeat(400));
    const zip = buildZip([
      { name: "altorank/", data: new Uint8Array(0), mtime: new Date("2026-09-06T10:00:00Z") },
      { name: "altorank/altorank.php", data: big, mtime: new Date("2026-09-06T10:00:00Z") },
      { name: "altorank/includes/", data: new Uint8Array(0), mtime: new Date("2026-09-06T10:00:00Z") },
      { name: "altorank/includes/x.php", data: Buffer.from("<?php"), mtime: new Date("2026-09-06T10:00:00Z") },
    ]);
    const read = readZip(zip);
    expect(read.map((r) => r.name)).toEqual(["altorank/", "altorank/altorank.php", "altorank/includes/", "altorank/includes/x.php"]);
    expect(read[0].isDir).toBe(true);
    expect(read[1].isDir).toBe(false);
    expect(read[1].data.equals(big)).toBe(true);
    // Repetitive text is deflated; a five-byte file is stored as-is.
    expect(read[1].method).toBe(8);
    expect(read[3].method).toBe(0);
    expect(read[3].data.toString()).toBe("<?php");
  });

  it("is deterministic for the same input", () => {
    const entries = [{ name: "altorank/a.php", data: Buffer.from("<?php echo 1;"), mtime: new Date("2026-01-01T00:00:00Z") }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });
});

describe("collectPluginEntries", () => {
  it("roots every entry at altorank/ and leaves OS litter out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "altorank-plugin-"));
    try {
      await fs.mkdir(path.join(dir, "includes"));
      await fs.writeFile(path.join(dir, "altorank.php"), "<?php\n/**\n * Version:           9.9.9\n */\n");
      await fs.writeFile(path.join(dir, "includes", "api.php"), "<?php");
      await fs.writeFile(path.join(dir, ".DS_Store"), "junk");
      await fs.writeFile(path.join(dir, "includes", ".DS_Store"), "junk");
      const entries = await collectPluginEntries(dir);
      expect(entries.map((e) => e.name)).toEqual(["altorank/", "altorank/altorank.php", "altorank/includes/", "altorank/includes/api.php"]);
      expect(await readPluginVersion(dir)).toBe("9.9.9");
      const built = await buildPluginZip(dir);
      expect(built.version).toBe("9.9.9");
      expect(readZip(built.bytes).map((r) => r.name)).toContain("altorank/includes/api.php");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the shipped plugin", () => {
  it("is found from apps/web and packs as the tree WordPress expects", async () => {
    const dir = await findPluginSourceDir();
    expect(dir).not.toBeNull();
    const built = await buildPluginZip(dir!);
    const names = readZip(built.bytes).map((r) => r.name);
    // One top-level directory named after the slug, with the main file in it.
    expect(names[0]).toBe("altorank/");
    expect(names.every((n) => n.startsWith("altorank/"))).toBe(true);
    expect(names).toContain("altorank/altorank.php");
    expect(names).toContain("altorank/readme.txt");
    expect(names).toContain("altorank/includes/api.php");
    expect(names).toContain("altorank/includes/settings.php");
    expect(names).toContain("altorank/uninstall.php");
    expect(built.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports no source when run from a directory without the package", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "altorank-nowhere-"));
    try {
      expect(await findPluginSourceDir(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/public/wordpress-plugin", () => {
  it("serves the archive as an attachment named altorank.zip", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="altorank.zip"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(String(bytes.length)).toBe(res.headers.get("content-length"));
    expect(readZip(bytes).map((r) => r.name)).toContain("altorank/altorank.php");
  });
});
