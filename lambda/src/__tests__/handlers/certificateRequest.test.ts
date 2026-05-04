import { handleCertificateRequest } from '../../handlers/certificateRequest';
import { describeCertificate } from '../../services/acm';
import { findZone, upsertCnameRecord } from '../../services/cloudflare';

jest.mock('../../services/acm');
jest.mock('../../services/cloudflare');

const mockDescribeCertificate = jest.mocked(describeCertificate);
const mockFindZone = jest.mocked(findZone);
const mockUpsertCnameRecord = jest.mocked(upsertCnameRecord);

const CERT_ARN = 'arn:aws:acm:ap-northeast-1:123:certificate/test';
const BASE_EVENT = {
  source: 'aws.cloudtrail' as const,
  'detail-type': 'AWS API Call via CloudTrail' as const,
};

describe('handleCertificateRequest', () => {
  it('throws when certificateArn is missing from event', async () => {
    await expect(handleCertificateRequest({ ...BASE_EVENT, detail: {} }))
      .rejects.toThrow('certificateArn not found in CloudTrail event');
  });

  it('calls describeCertificate with the ARN from the event', async () => {
    mockDescribeCertificate.mockResolvedValue({
      arn: CERT_ARN,
      domainName: 'example.com',
      cnameRecords: [],
    });

    await handleCertificateRequest({
      ...BASE_EVENT,
      detail: { responseElements: { certificateArn: CERT_ARN } },
    });

    expect(mockDescribeCertificate).toHaveBeenCalledWith(CERT_ARN);
  });

  it('syncs all CNAME records via findZone and upsertCnameRecord', async () => {
    mockDescribeCertificate.mockResolvedValue({
      arn: CERT_ARN,
      domainName: 'example.com',
      cnameRecords: [
        { name: '_abc.example.com', value: '_def.acm-validations.aws' },
        { name: '_abc.sub.example.com', value: '_ghi.acm-validations.aws' },
      ],
    });
    mockFindZone.mockResolvedValue('zone-id-1');
    mockUpsertCnameRecord.mockResolvedValue(undefined);

    await handleCertificateRequest({
      ...BASE_EVENT,
      detail: { responseElements: { certificateArn: CERT_ARN } },
    });

    expect(mockFindZone).toHaveBeenCalledTimes(2);
    expect(mockUpsertCnameRecord).toHaveBeenCalledTimes(2);
    expect(mockUpsertCnameRecord).toHaveBeenCalledWith(
      'zone-id-1',
      '_abc.example.com',
      '_def.acm-validations.aws',
    );
    expect(mockUpsertCnameRecord).toHaveBeenCalledWith(
      'zone-id-1',
      '_abc.sub.example.com',
      '_ghi.acm-validations.aws',
    );
  });
});
