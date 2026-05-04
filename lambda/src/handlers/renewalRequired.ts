import { describeCertificate } from '../services/acm';
import { findZone, upsertCnameRecord } from '../services/cloudflare';
import { RenewalRequiredEvent } from '../types';

export async function handleRenewalRequired(event: RenewalRequiredEvent): Promise<void> {
  const arn = event.detail.CertificateArn;
  if (!arn) throw new Error('CertificateArn not found in ACM renewal event');

  console.log(`Renewal action required: ${arn}`);
  const cert = await describeCertificate(arn);

  for (const cname of cert.cnameRecords) {
    const zoneId = await findZone(cname.name);
    await upsertCnameRecord(zoneId, cname.name, cname.value);
  }

  console.log(`Synced ${cert.cnameRecords.length} CNAME record(s) for ${cert.domainName}`);
}
