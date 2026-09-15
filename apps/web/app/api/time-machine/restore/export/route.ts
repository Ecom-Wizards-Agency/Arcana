import { handleRestoreExport } from '../../../../../src/time-machine/export-http';
export const runtime='nodejs';
export function POST(request:Request):Promise<Response> { return handleRestoreExport(request); }
