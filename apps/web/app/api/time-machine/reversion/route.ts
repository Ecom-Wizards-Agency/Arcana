/** Compatibility entry for saved export clients; all writes use the restore export command. */
import { handleRestoreExport } from '../../../../src/time-machine/export-http';
export const runtime='nodejs';
export function POST(request:Request):Promise<Response> { return handleRestoreExport(request,true); }
