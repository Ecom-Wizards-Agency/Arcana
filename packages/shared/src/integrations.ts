import { z } from 'zod';

/** External credential providers, shared by forms, persistence and workers. */
export const INTEGRATION_PROVIDERS = ['keepa', 'datadive', 'mrp'] as const;
export const IntegrationProvider = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;
