import { X509Certificate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import process from 'node:process';
import * as tls from 'node:tls';
import { URL } from 'node:url';

export const RECOMMENDATION_DATABASE_CA = '/etc/openspell/recommendation-database-ca.pem';
const MAX_CA_BYTES = 131_072;
const TLS_SELECTORS = [
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** A public certificate bundle only; never a private key or arbitrary PEM text. */
export function parseRecommendationDatabaseCa(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_CA_BYTES) {
    throw new Error('Recommendation database CA is invalid');
  }
  const certificates = input.match(/-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu) ?? [];
  if (certificates.length === 0 || certificates.length > 16
    || input.replace(/-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu, '').trim()) {
    throw new Error('Recommendation database CA is invalid');
  }
  return certificates.map((pem) => {
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) throw new Error('Recommendation database CA is invalid');
    return certificate.toString();
  });
}

function safeMetadata(metadata, file) {
  if (metadata.uid !== 0 || metadata.gid !== 0 || metadata.isSymbolicLink()
    || (metadata.mode & 0o7022) !== 0
    || (file ? !metadata.isFile() : !metadata.isDirectory())
    || (file && ![0o444, 0o644].includes(metadata.mode & 0o7777))) {
    throw new Error('Recommendation database CA path is unsafe');
  }
}

/** Optional absence is distinct from an unsafe, unreadable or malformed input. */
function fixedCa() {
  for (const path of ['/', '/etc', '/etc/openspell', RECOMMENDATION_DATABASE_CA]) {
    let metadata;
    try { metadata = lstatSync(path); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    const file = path === RECOMMENDATION_DATABASE_CA;
    safeMetadata(metadata, file);
    if (!file) continue;
    if (metadata.size === 0 || metadata.size > MAX_CA_BYTES) throw new Error('Recommendation database CA is invalid');
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      safeMetadata(opened, true);
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
        throw new Error('Recommendation database CA changed while opening');
      }
      return parseRecommendationDatabaseCa(readFileSync(descriptor, 'utf8'));
    } finally { closeSync(descriptor); }
  }
  return undefined;
}

/** One fixed root-owned input. No caller-supplied certificate path or TLS override. */
export function recommendationDatabaseTls(databaseUrl, environment = process.env) {
  if (TLS_SELECTORS.some((key) => environment[key] !== undefined || process.env[key] !== undefined)) {
    throw new Error('Recommendation database received an ambient TLS setting');
  }
  const certificates = fixedCa();
  if (certificates === undefined) return undefined;
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash
    || [...url.searchParams.keys()].some((key) => key !== 'sslmode')
    || url.searchParams.getAll('sslmode').length !== 1
    || url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Recommendation database custom CA requires verify-full');
  }
  const defaults = typeof tls.getCACertificates === 'function'
    ? tls.getCACertificates('default') : tls.rootCertificates;
  return { ca: [...defaults, ...certificates], rejectUnauthorized: true };
}

/** Dedicated preview worker/readback processes only, before any DB client exists. */
export function initializeRecommendationDatabaseTrust(databaseUrl, environment = process.env) {
  const options = recommendationDatabaseTls(databaseUrl, environment);
  if (options === undefined) return;
  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error('Recommendation database custom CA requires Node 22.19 or newer');
  }
  tls.setDefaultCACertificates(options.ca);
}
