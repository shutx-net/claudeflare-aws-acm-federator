import { handleRenewalRequired } from '../../handlers/renewalRequired';
import { describeCertificate } from '../../services/acm';
import { findZone, upsertCnameRecord } from '../../services/cloudflare';

jest.mock('../../services/acm');
jest.mock('../../services/cloudflare');

const mockDescribeCertificate = jest.mocked(describeCertificate);
const mockFindZone = jest.mocked(findZone);
const mockUpsertCnameRecord = jest.mocked(upsertCnameRecord);

const CERT_ARN = 'arn:aws:acm:ap-northeast-1:123:certificate/test';
const BASE_EVENT = {
  source: 'aws.acm' as const,
  'detail-type': 'ACM Certificate Renewal Action Required' as const,
};

describe('handleRenewalRequired', () => {
  it('throws when CertificateArn is missing from event', async () => {
    await expect(handleRenewalRequired({ ...BASE_EVENT, detail: {} }))
      .rejects.toThrow('CertificateArn not found in ACM renewal event');
  });

  it('calls describeCertificate with the ARN from the event', async () => {
    mockDescribeCertificate.mockResolvedValue({
      arn: CERT_ARN,
      domainName: 'example.com',
      cnameRecords: [],
    });

    await handleRenewalRequired({ ...BASE_EVENT, detail: { CertificateArn: CERT_ARN } });

    expect(mockDescribeCertificate).toHaveBeenCalledWith(CERT_ARN);
  });

  it('syncs all CNAME records via findZone and upsertCnameRecord', async () => {
    mockDescribeCertificate.mockResolvedValue({
      arn: CERT_ARN,
      domainName: 'example.com',
      cnameRecords: [
        { name: '_abc.example.com', value: '_def.acm-validations.aws' },
      ],
    });
    mockFindZone.mockResolvedValue('zone-id-1');
    mockUpsertCnameRecord.mockResolvedValue(undefined);

    await handleRenewalRequired({ ...BASE_EVENT, detail: { CertificateArn: CERT_ARN } });

    expect(mockFindZone).toHaveBeenCalledWith('_abc.example.com');
    expect(mockUpsertCnameRecord).toHaveBeenCalledWith(
      'zone-id-1',
      '_abc.example.com',
      '_def.acm-validations.aws',
    );
  });
});
