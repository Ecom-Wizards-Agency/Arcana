import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StoredCollectorExport, SPONSORED_PROMPT_IMPORT_MAX_BYTES } from '@wizard-ads/shared';
import { CollectorRefusalError } from './refusal.js';

export async function readCollectorExport(root: string | undefined, raw: StoredCollectorExport): Promise<{ fingerprint: string; value: unknown } | null> {
  const parsed = StoredCollectorExport.safeParse(raw);
  if (!parsed.success) throw new CollectorRefusalError('unauthorized_reference', 'Invalid export reference');
  const ref = parsed.data;
  if (!root || !ref.enabled) return null;
  try {
    const base = await realpath(root); const file = await realpath(resolve(base,ref.objectKey));
    const child = relative(base,file);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new CollectorRefusalError('invalid_file_bounds', 'Export escaped configured root');
    const handle = await open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > SPONSORED_PROMPT_IMPORT_MAX_BYTES) throw new CollectorRefusalError('invalid_file_bounds', 'Export is not a bounded regular file');
      const bytes = Buffer.alloc(SPONSORED_PROMPT_IMPORT_MAX_BYTES+1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes,length,bytes.length-length,null); if (read.bytesRead === 0) break; length += read.bytesRead; }
      if (length > SPONSORED_PROMPT_IMPORT_MAX_BYTES) throw new CollectorRefusalError('invalid_file_bounds', 'Export exceeds byte limit');
      const content = bytes.subarray(0,length);
      try { return { fingerprint:createHash('sha256').update(content).digest('hex'),value:JSON.parse(content.toString('utf8')) as unknown }; }
      catch { throw new CollectorRefusalError('malformed_content', 'Malformed JSON export'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
