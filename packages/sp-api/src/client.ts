import { gunzipSync } from 'node:zlib';
import { SpApiAmbiguousOutcome, SpApiAuthError, SpApiError, SpApiParseError } from './errors.js';
import type {
  CreateReportInput,
  SpApiClientOptions,
  SpApiReport,
  SpApiReportDocument,
} from './types.js';

const REPORTS_PATH = '/reports/2021-06-30';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpApiParseError(`${label} returned no ${key}`);
  }
  return value;
}

function amazonTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function safeErrorMessage(status: number, body: unknown): string {
  if (!isRecord(body)) return `SP-API request failed with ${status}`;
  const errors = body['errors'];
  if (!Array.isArray(errors)) return `SP-API request failed with ${status}`;
  const first = errors[0];
  if (!isRecord(first)) return `SP-API request failed with ${status}`;
  const code = typeof first['code'] === 'string' ? first['code'] : 'unknown_error';
  const message = typeof first['message'] === 'string' ? first['message'] : 'no message returned';
  return `SP-API request failed with ${status}: ${code}: ${message}`;
}

export class SpApiClient {
  private readonly endpoint: string;
  private readonly fetchImpl: NonNullable<SpApiClientOptions['fetch']>;
  private readonly sleep: NonNullable<SpApiClientOptions['sleep']>;
  private readonly now: NonNullable<SpApiClientOptions['now']>;
  private readonly maxRetries: number;

  constructor(private readonly options: SpApiClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async request(path: string, init: { method: string; body?: unknown; maxRetries?: number; create?: boolean }): Promise<unknown> {
    let authRetried = false;
    const maxRetries = init.maxRetries ?? this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let access: string;
      try { access = await this.options.accessTokenProvider.getAccessToken(); }
      catch (error) {
        // No Reports request has been sent; the checkpoint may safely retry auth.
        if (error instanceof SpApiAuthError) throw error;
        throw new SpApiAuthError('SP-API access credential could not be acquired', 0);
      }
      let response: Response;
      try { response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': this.options.userAgent,
          'x-amz-access-token': access,
          'x-amz-date': amazonTimestamp(this.now()),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }); } catch (error) {
        if (init.create) throw new SpApiAmbiguousOutcome('transport');
        throw error;
      }
      if (init.create && (response.status >= 500 || response.status === 408)) {
        throw new SpApiAmbiguousOutcome('server-response', response.status);
      }

      let body: unknown = null;
      let text: string;
      try { text = await response.text(); } catch (error) {
        if (init.create) throw new SpApiAmbiguousOutcome('response-decoding', response.status);
        throw error;
      }
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          if (init.create && response.ok) throw new SpApiAmbiguousOutcome('response-decoding', response.status);
          if (response.ok) throw new SpApiParseError(`SP-API returned non-JSON for ${init.method} ${path}`);
        }
      }

      if (response.ok) return body;

      const authRefused = response.status === 401 || response.status === 403;
      if (!authRetried && authRefused && this.options.accessTokenProvider.invalidate) {
        authRetried = true;
        this.options.accessTokenProvider.invalidate();
        // Authentication recovery is one replacement attempt, not part of the
        // transport retry budget. This also works when maxRetries is zero.
        attempt -= 1;
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      const header = response.headers.get('retry-after');
      const retryAfter = header === null ? NaN : Number(header);
      if (!retryable || attempt === maxRetries) {
        throw new SpApiError(safeErrorMessage(response.status, body), response.status, retryable,
          Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
      }
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1_000
        : Math.min(1_000 * 2 ** attempt, 30_000);
      await this.sleep(delay);
    }
    throw new SpApiError('SP-API retry loop exhausted', 0, true);
  }

  async createReport(input: CreateReportInput): Promise<{ reportId: string }> {
    const body = await this.request(`${REPORTS_PATH}/reports`, {
      method: 'POST',
      maxRetries: 0,
      create: true,
      body: {
        reportType: input.reportType,
        marketplaceIds: [input.marketplaceId],
        dataStartTime: input.dataStartTime,
        dataEndTime: input.dataEndTime,
        ...(input.reportOptions === undefined ? {} : { reportOptions: input.reportOptions }),
      },
    });
    if (!isRecord(body) || typeof body['reportId'] !== 'string' || body['reportId'].length === 0) {
      throw new SpApiAmbiguousOutcome('response-decoding');
    }
    return { reportId: body['reportId'] };
  }

  async getReport(reportId: string): Promise<SpApiReport> {
    const body = await this.request(`${REPORTS_PATH}/reports/${encodeURIComponent(reportId)}`, {
      method: 'GET',
    });
    if (!isRecord(body)) throw new SpApiParseError('getReport returned no object');
    return {
      reportId: requiredString(body, 'reportId', 'getReport'),
      reportType: stringOrNull(body['reportType']),
      processingStatus: requiredString(body, 'processingStatus', 'getReport'),
      reportDocumentId: stringOrNull(body['reportDocumentId']),
      createdTime: stringOrNull(body['createdTime']),
    };
  }

  async getReportDocument(reportDocumentId: string): Promise<SpApiReportDocument> {
    const body = await this.request(
      `${REPORTS_PATH}/documents/${encodeURIComponent(reportDocumentId)}`,
      { method: 'GET' },
    );
    if (!isRecord(body)) throw new SpApiParseError('getReportDocument returned no object');
    const compression = body['compressionAlgorithm'];
    if (compression !== undefined && compression !== 'GZIP') {
      throw new SpApiParseError('getReportDocument returned an unsupported compression algorithm');
    }
    return {
      reportDocumentId,
      url: requiredString(body, 'url', 'getReportDocument'),
      compressionAlgorithm: compression === 'GZIP' ? 'GZIP' : null,
    };
  }

  /** Pre-signed report URLs receive no SP-API authorization header. */
  async downloadReportDocumentText(document: SpApiReportDocument): Promise<string> {
    const response = await this.fetchImpl(document.url, { method: 'GET' });
    if (!response.ok) {
      throw new SpApiError(`report document download failed with ${response.status}`, response.status, response.status >= 500);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = document.compressionAlgorithm === 'GZIP' ? gunzipSync(bytes) : bytes;
    return new TextDecoder().decode(decoded);
  }

  /** JSON reports retain their existing convenience API; TSV uses the text method. */
  async downloadReportDocument(document: SpApiReportDocument): Promise<unknown> {
    const text = await this.downloadReportDocumentText(document);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SpApiParseError('report document is not valid JSON');
    }
  }
}
