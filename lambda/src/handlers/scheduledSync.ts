import { describeCertificate, listAllCertificateCnames, listPendingCertificates } from '../services/acm';
import {
  deleteCnameRecord,
  findZone,
  listAcmValidationCnames,
  listAllZoneIds,
  upsertCnameRecord,
} from '../services/cloudflare';

export async function handleScheduledSync(): Promise<void> {
  await syncPendingCertificates();
  await cleanupStaleCnames();
}

async function syncPendingCertificates(): Promise<void> {
  console.log('Starting scheduled sync of PENDING_VALIDATION certificates');
  const arns = await listPendingCertificates();
  console.log(`Found ${arns.length} pending certificate(s)`);

  for (const arn of arns) {
    try {
      const cert = await describeCertificate(arn);
      for (const cname of cert.cnameRecords) {
        const zoneId = await findZone(cname.name);
        await upsertCnameRecord(zoneId, cname.name, cname.value);
      }
      console.log(`Synced ${cert.cnameRecords.length} CNAME record(s) for ${cert.domainName}`);
    } catch (err) {
      // Log and continue — one failure should not block other certificates.
      console.error(`Failed to sync ${arn}:`, err);
    }
  }
}

async function cleanupStaleCnames(): Promise<void> {
  console.log('Starting stale CNAME cleanup');

  // Collect CNAME names that ACM currently requires (all statuses, ap-northeast-1).
  const activeCnameNames = await listAllCertificateCnames();
  console.log(`ACM has ${activeCnameNames.size} active validation CNAME name(s)`);

  const zoneIds = await listAllZoneIds();
  let deletedCount = 0;

  for (const zoneId of zoneIds) {
    const acmRecords = await listAcmValidationCnames(zoneId);

    for (const record of acmRecords) {
      if (!activeCnameNames.has(record.name)) {
        console.log(`Deleting stale CNAME: ${record.name} → ${record.content}`);
        try {
          await deleteCnameRecord(zoneId, record.id);
          deletedCount++;
        } catch (err) {
          console.error(`Failed to delete record ${record.name}:`, err);
        }
      }
    }
  }

  console.log(`Cleanup complete. Deleted ${deletedCount} stale CNAME record(s)`);
}
