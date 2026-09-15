import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StoredCollectorExport } from '@wizard-ads/shared';
import { readCollectorExport } from './exports.js';
let root:string;
const ref:StoredCollectorExport={id:'00000000-0000-4000-8000-000000000003',scope:{orgId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',marketplace:'US'},family:'prompts',enabled:true,objectKey:'export.json'};
beforeAll(async()=>{const scratch=process.env['WP_SCRATCH'];root=await mkdtemp(join(scratch?join(scratch,'tmp'):tmpdir(),'exports-'));});
afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true});});
it('handles missing files and preserves content fingerprints',async()=>{
  expect(await readCollectorExport(root,ref)).toBeNull();
  await writeFile(join(root,ref.objectKey),'{"synthetic":true}');
  const first=await readCollectorExport(root,ref);expect(first?.value).toEqual({synthetic:true});expect(await readCollectorExport(root,ref)).toEqual(first);
  expect(await readCollectorExport(undefined,ref)).toBeNull();
});
it('rejects malformed and oversized exports',async()=>{
  await writeFile(join(root,ref.objectKey),'{');await expect(readCollectorExport(root,ref)).rejects.toThrow('Malformed');
  await writeFile(join(root,ref.objectKey),'x'.repeat(2*1024*1024+1));await expect(readCollectorExport(root,ref)).rejects.toThrow('bounded');
});
it('refuses a symlink outside its configured root',async()=>{
  const outside=await mkdtemp(join(process.env['WP_SCRATCH']?join(process.env['WP_SCRATCH'],'tmp'):tmpdir(),'outside-export-'));
  try {
    await writeFile(join(outside,'source.json'),'{}');
    await symlink(join(outside,'source.json'),join(root,'escape.json'));
    await expect(readCollectorExport(root,{...ref,objectKey:'escape.json'})).rejects.toThrow('escaped');
  } finally { await rm(outside,{recursive:true,force:true}); }
});
