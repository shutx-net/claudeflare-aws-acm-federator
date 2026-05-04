import { describeCertificate } from '../services/acm';
import { findZone, upsertCnameRecord } from '../services/cloudflare';
import { CertificateRequestEvent } from '../types';

export async function handleCertificateRequest(event: CertificateRequestEvent): Promise<void> {
  const arn = event.detail.responseElements?.certificateArn;
  if (!arn) throw new Error('certificateArn not found in CloudTrail event');

  console.log(`New certificate requested: ${arn}`);
  const cert = await describeCertificate(arn);

  for (const cname of cert.cnameRecords) {
    const zoneId = await findZone(cname.name);
    await upsertCnameRecord(zoneId, cname.name, cname.value);
  }

  console.log(`Synced ${cert.cnameRecords.length} CNAME record(s) for ${cert.domainName}`);
}
