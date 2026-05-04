import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import Cloudflare from 'cloudflare';

function wrapApiError(err: unknown, operation: string): Error {
  if (err instanceof Cloudflare.APIError) {
    return new Error(
      `CloudFlare API error during "${operation}": status=${err.status} name=${err.name} message=${err.message}`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

const SECRET_NAME = process.env.SECRET_NAME!;

let cachedClient: Cloudflare | null = null;

async function getClient(): Promise<Cloudflare> {
  if (cachedClient) return cachedClient;

  const smClient = new SecretsManagerClient({});
  const { SecretString } = await smClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_NAME }),
  );
  const secret = JSON.parse(SecretString!) as { token: string };

  // timeout: shorter than Lambda's 60s to avoid racing with the Lambda kill signal.
  // maxRetries: one more than the SDK default (2) for resilience against 429 / 5xx.
  cachedClient = new Cloudflare({ apiToken: secret.token, timeout: 30_000, maxRetries: 3 });
  return cachedClient;
}

export async function findZone(domain: string): Promise<string> {
  const cf = await getClient();
  const parts = domain.replace(/\.$/, '').split('.');

  // Walk from the full hostname toward the apex to find which zone owns the record.
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    for await (const zone of cf.zones.list({ name: candidate })) {
      if (zone.name === candidate) return zone.id;
    }
  }

  throw new Error(`No CloudFlare zone found for domain: ${domain}`);
}

export async function listAllZoneIds(): Promise<string[]> {
  const cf = await getClient();
  const zoneIds: string[] = [];
  for await (const zone of cf.zones.list()) {
    zoneIds.push(zone.id);
  }
  return zoneIds;
}

export interface AcmValidationRecord {
  id: string;
  name: string;
  content: string;
}

export async function listAcmValidationCnames(zoneId: string): Promise<AcmValidationRecord[]> {
  const cf = await getClient();
  const records: AcmValidationRecord[] = [];

  for await (const record of cf.dns.records.list({ zone_id: zoneId, type: 'CNAME' })) {
    if (record.content?.endsWith('.acm-validations.aws')) {
      records.push({ id: record.id, name: record.name, content: record.content });
    }
  }

  return records;
}

export async function deleteCnameRecord(zoneId: string, recordId: string): Promise<void> {
  const cf = await getClient();
  try {
    await cf.dns.records.delete(recordId, { zone_id: zoneId });
    console.log(`Deleted CNAME record: ${recordId} (zone: ${zoneId})`);
  } catch (err) {
    throw wrapApiError(err, `delete record ${recordId}`);
  }
}

export async function upsertCnameRecord(
  zoneId: string,
  name: string,
  value: string,
): Promise<void> {
  const cf = await getClient();

  // ACM appends a trailing dot to validation record names and values; strip it.
  const recordName = name.replace(/\.$/, '');
  const recordValue = value.replace(/\.$/, '');

  let existingId: string | undefined;
  for await (const record of cf.dns.records.list({
    zone_id: zoneId,
    type: 'CNAME',
    name: { exact: recordName },
  })) {
    existingId = record.id;
    break;
  }

  try {
    if (existingId) {
      await cf.dns.records.update(existingId, {
        zone_id: zoneId,
        type: 'CNAME',
        name: recordName,
        content: recordValue,
        ttl: 1,
      });
      console.log(`Updated CNAME: ${recordName} → ${recordValue}`);
    } else {
      await cf.dns.records.create({
        zone_id: zoneId,
        type: 'CNAME',
        name: recordName,
        content: recordValue,
        ttl: 1,
      });
      console.log(`Created CNAME: ${recordName} → ${recordValue}`);
    }
  } catch (err) {
    throw wrapApiError(err, `upsert record ${recordName}`);
  }
}
