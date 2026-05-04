import {
  ACMClient,
  CertificateStatus,
  DescribeCertificateCommand,
  ListCertificatesCommand,
} from '@aws-sdk/client-acm';
import { CertificateInfo, CnameRecord } from '../types';


const client = new ACMClient({});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function describeCertificate(arn: string): Promise<CertificateInfo> {
  // ACM may not have generated CNAME validation records immediately after RequestCertificate.
  // Retry with exponential backoff: 0s, 2s, 4s.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(Math.pow(2, attempt) * 1000);
    }

    const { Certificate } = await client.send(
      new DescribeCertificateCommand({ CertificateArn: arn }),
    );

    if (!Certificate?.DomainName) {
      throw new Error(`Certificate not found: ${arn}`);
    }

    const cnameRecords: CnameRecord[] = (Certificate.DomainValidationOptions ?? [])
      .filter(
        (opt) =>
          opt.ResourceRecord?.Type === 'CNAME' &&
          opt.ResourceRecord.Name &&
          opt.ResourceRecord.Value,
      )
      .map((opt) => ({
        name: opt.ResourceRecord!.Name!,
        value: opt.ResourceRecord!.Value!,
      }));

    if (cnameRecords.length > 0) {
      return { arn, domainName: Certificate.DomainName, cnameRecords };
    }
  }

  throw new Error(`No CNAME validation records available for ${arn} after retries`);
}

export async function listPendingCertificates(): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListCertificatesCommand({
        CertificateStatuses: [CertificateStatus.PENDING_VALIDATION],
        NextToken: nextToken,
      }),
    );

    for (const cert of response.CertificateSummaryList ?? []) {
      if (cert.CertificateArn) arns.push(cert.CertificateArn);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return arns;
}

export async function listAllCertificateCnames(): Promise<Set<string>> {
  // List all certificates regardless of status.
  const arns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListCertificatesCommand({ NextToken: nextToken }),
    );
    for (const cert of response.CertificateSummaryList ?? []) {
      if (cert.CertificateArn) arns.push(cert.CertificateArn);
    }
    nextToken = response.NextToken;
  } while (nextToken);

  // Describe all certificates concurrently to collect CNAME names.
  const cnameNames = new Set<string>();

  await Promise.all(
    arns.map(async (arn) => {
      try {
        const { Certificate } = await client.send(
          new DescribeCertificateCommand({ CertificateArn: arn }),
        );
        for (const opt of Certificate?.DomainValidationOptions ?? []) {
          if (opt.ResourceRecord?.Type === 'CNAME' && opt.ResourceRecord.Name) {
            cnameNames.add(opt.ResourceRecord.Name.replace(/\.$/, ''));
          }
        }
      } catch (err) {
        console.warn(`Could not describe certificate ${arn}:`, err);
      }
    }),
  );

  return cnameNames;
}
