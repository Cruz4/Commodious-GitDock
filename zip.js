'use strict';
/**
 * ZIP32 reader for ordinary stored/deflated project archives.
 * Streams each entry with strict size/path limits; no npm dependencies.
 * Intentionally refuses encrypted, multi-disk, and Zip64 archives.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_ZIP = 1024 * 1024 * 1024;
const MAX_DIR = 32 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let j = 0; j < 8; j++) n = n & 1 ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});
function crcUpdate(crc, data) {
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

async function readAt(handle, offset, size) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const { bytesRead } = await handle.read(buffer, read, size - read, offset + read);
    if (!bytesRead) throw Error('ZIP archive was truncated.');
    read += bytesRead;
  }
  return buffer;
}

function decodeName(bytes, utf8) {
  // UTF-8 is standard for modern GitHub archives. Legacy 7-bit ASCII is compatible.
  // Invalid UTF-8 or non-ASCII legacy code page names are rejected instead of mangled.
  const name = bytes.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(bytes)) throw Error('ZIP uses an unsupported filename encoding.');
  if (!utf8 && [...bytes].some(b => b > 127)) throw Error('ZIP uses legacy non-UTF-8 file names. Rezip with UTF-8 encoding.');
  return name;
}

async function readZipEntries(zipPath) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_ZIP) throw Error('ZIP exceeds the 1 GB upload limit.');
    if (stat.size < 22) throw Error('Not a valid ZIP archive.');
    const tailSize = Math.min(stat.size, 65557);
    const tail = await readAt(handle, stat.size - tailSize, tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw Error('Could not find the ZIP directory.');
    const disk = tail.readUInt16LE(eocd + 4);
    const diskWithDir = tail.readUInt16LE(eocd + 6);
    const entriesThisDisk = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (disk || diskWithDir || entriesThisDisk !== totalEntries) throw Error('Multi-part ZIP archives are unsupported.');
    if (totalEntries === 65535 || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw Error('ZIP64 archives are unsupported. Please create a standard ZIP.');
    if (totalEntries > MAX_ENTRIES || dirSize > MAX_DIR) throw Error('ZIP has too many entries or oversized metadata.');
    if (dirOffset + dirSize > stat.size) throw Error('Invalid ZIP directory range.');
    const data = await readAt(handle, dirOffset, dirSize);
    const entries = [];
    let i = 0;
    for (let n = 0; n < totalEntries; n++) {
      if (i + 46 > data.length || data.readUInt32LE(i) !== 0x02014b50) throw Error('Invalid ZIP directory entry.');
      const flags = data.readUInt16LE(i + 8);
      const method = data.readUInt16LE(i + 10);
      const crc = data.readUInt32LE(i + 16);
      const compressed = data.readUInt32LE(i + 20);
      const size = data.readUInt32LE(i + 24);
      const filenameLength = data.readUInt16LE(i + 28);
      const extra = data.readUInt16LE(i + 30);
      const comment = data.readUInt16LE(i + 32);
      const externalAttrs = data.readUInt32LE(i + 38);
      const localOffset = data.readUInt32LE(i + 42);
      if (i + 46 + filenameLength + extra + comment > data.length) throw Error('Truncated ZIP file name.');
      const name = decodeName(data.subarray(i + 46, i + 46 + filenameLength), !!(flags & 0x800)).replace(/\\/g, '/');
      i += 46 + filenameLength + extra + comment;
      if (!name || name.endsWith('/')) continue;
      if (flags & 1) throw Error('Password-protected ZIP files are unsupported.');
      if (![0, 8].includes(method)) throw Error(`ZIP compression format unsupported for ${name}.`);
      if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw Error('ZIP64 archive entries are unsupported.');
      if (((externalAttrs >>> 16) & 0o170000) === 0o120000) throw Error('ZIP symlinks are unsupported.');
      if (localOffset + 30 > dirOffset) throw Error('Invalid ZIP entry location.');
      entries.push({ name, flags, method, compressed, size, crc, localOffset });
    }
    return entries;
  } finally { await handle.close(); }
}

async function extractEntry(zipPath, entry, target, maximum) {
  const handle = await fsp.open(zipPath, 'r');
  let dataStart;
  try {
    const header = await readAt(handle, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw Error('ZIP local entry header is invalid.');
    const localMethod = header.readUInt16LE(8);
    if (localMethod !== entry.method) throw Error('Inconsistent ZIP compression method.');
    dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const { size: total } = await handle.stat();
    if (dataStart + entry.compressed > total) throw Error('ZIP entry exceeds archive bounds.');
  } finally { await handle.close(); }
  if (entry.size > maximum) throw Error(`File in ZIP is too large for GitHub: ${entry.name}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (entry.compressed === 0) {
    if (entry.size || entry.crc) throw Error('ZIP entry has mismatched sizes or checksum.');
    await fsp.writeFile(target, Buffer.alloc(0));
    return 0;
  }
  let expanded = 0, crc = 0xffffffff;
  const limiter = new Transform({
    transform(chunk, _encoding, cb) {
      expanded += chunk.length;
      crc = crcUpdate(crc, chunk);
      if (expanded > maximum || expanded > entry.size) cb(Error(`ZIP file expanded beyond its stated size: ${entry.name}`));
      else cb(null, chunk);
    }
  });
  try {
    const stream = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressed - 1 });
    const sink = fs.createWriteStream(target, { flags: 'wx' });
    if (entry.method === 8) await pipeline(stream, zlib.createInflateRaw(), limiter, sink);
    else await pipeline(stream, limiter, sink);
    if (expanded !== entry.size) throw Error(`ZIP entry size mismatch: ${entry.name}`);
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw Error(`ZIP file checksum mismatch: ${entry.name}`);
    return expanded;
  } catch (error) {
    await fsp.rm(target, { force: true });
    throw error;
  }
}

module.exports = { readZipEntries, extractEntry, MAX_ZIP };
