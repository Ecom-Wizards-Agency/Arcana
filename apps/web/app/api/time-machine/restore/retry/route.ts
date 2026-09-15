import { prepareRestoreRetry } from '@wizard-ads/db';
import { OptimizerRetryRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteMutation } from '../../../../../src/writes/http';

export const runtime='nodejs';
export function POST(request:Request) {
  return handleSpWriteMutation(request,OptimizerRetryRequest,prepareRestoreRetry);
}
