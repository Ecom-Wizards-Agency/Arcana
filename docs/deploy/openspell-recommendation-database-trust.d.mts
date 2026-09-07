import type { ConnectionOptions } from 'node:tls';

export const RECOMMENDATION_DATABASE_CA: string;
export function parseRecommendationDatabaseCa(input: string): string[];
export function recommendationDatabaseTls(
  databaseUrl: string,
  environment?: Readonly<Record<string, string | undefined>>,
): (ConnectionOptions & { ca: string[]; rejectUnauthorized: true }) | undefined;
export function initializeRecommendationDatabaseTrust(
  databaseUrl: string,
  environment?: Readonly<Record<string, string | undefined>>,
): void;
