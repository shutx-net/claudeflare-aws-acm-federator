import { handleScheduledSync } from '../../handlers/scheduledSync';
import {
  describeCertificate,
  listAllCertificateCnames,
  listPendingCertificates,
} from '../../services/acm';
import {
  deleteCnameRecord,
  findZone,
  listAcmValidationCnames,
  listAllZoneIds,
  upsertCnameRecord,
} from '../../services/cloudflare';

jest.mock('../../services/acm');
jest.mock('../../services/cloudflare');

const mockListPendingCertificates = jest.mocked(listPendingCertificates);
const mockDescribeCertificate = jest.mocked(describeCertificate);
const mockListAllCertificateCnames = jest.mocked(listAllCertificateCnames);
const mockFindZone = jest.mocked(findZone);
const mockUpsertCnameRecord = jest.mocked(upsertCnameRecord);
const mockListAllZoneIds = jest.mocked(listAllZoneIds);
const mockListAcmValidationCnames = jest.mocked(listAcmValidationCnames);
const mockDeleteCnameRecord = jest.mocked(deleteCnameRecord);

const CERT_ARN_1 = 'arn:aws:acm:ap-northeast-1:123:certificate/cert1';
const CERT_ARN_2 = 'arn:aws:acm:ap-northeast-1:123:certificate/cert2';

beforeEach(() => {
  // Default no-op cleanup stubs (overridden per test as needed)
  mockListAllCertificateCnames.mockResolvedValue(new Set());
  mockListAllZoneIds.mockResolvedValue([]);
});

describe('handleScheduledSync — pending certificate sync', () => {
  it('syncs CNAME records for all pending certificates', async () => {
    mockListPendingCertificates.mockResolvedValue([CERT_ARN_1]);
    mockDescribeCertificate.mockResolvedValue({
      arn: CERT_ARN_1,
      domainName: 'example.com',
      cnameRecords: [{ name: '_abc.example.com', value: '_def.acm-validations.aws' }],
    });
    mockFindZone.mockResolvedValue('zone-1');
    mockUpsertCnameRecord.mockResolvedValue(undefined);

    await handleScheduledSync();

    expect(mockDescribeCertificate).toHaveBeenCalledWith(CERT_ARN_1);
    expect(mockUpsertCnameRecord).toHaveBeenCalledWith('zone-1', '_abc.example.com', '_def.acm-validations.aws');
  });

  it('continues processing other certs when one fails', async () => {
    mockListPendingCertificates.mockResolvedValue([CERT_ARN_1, CERT_ARN_2]);
    mockDescribeCertificate
      .mockRejectedValueOnce(new Error('ACM timeout'))
      .mockResolvedValueOnce({
        arn: CERT_ARN_2,
        domainName: 'other.com',
        cnameRecords: [{ name: '_xyz.other.com', value: '_uvw.acm-validations.aws' }],
      });
    mockFindZone.mockResolvedValue('zone-2');
    mockUpsertCnameRecord.mockResolvedValue(undefined);

    await expect(handleScheduledSync()).resolves.not.toThrow();
    expect(mockUpsertCnameRecord).toHaveBeenCalledTimes(1);
    expect(mockUpsertCnameRecord).toHaveBeenCalledWith('zone-2', '_xyz.other.com', '_uvw.acm-validations.aws');
  });
});

describe('handleScheduledSync — stale CNAME cleanup', () => {
  beforeEach(() => {
    mockListPendingCertificates.mockResolvedValue([]);
  });

  it('deletes CNAME records not present in ACM', async () => {
    mockListAllCertificateCnames.mockResolvedValue(new Set(['_active.example.com']));
    mockListAllZoneIds.mockResolvedValue(['zone-1']);
    mockListAcmValidationCnames.mockResolvedValue([
      { id: 'rec-active', name: '_active.example.com', content: '_a.acm-validations.aws' },
      { id: 'rec-stale', name: '_stale.example.com', content: '_b.acm-validations.aws' },
    ]);
    mockDeleteCnameRecord.mockResolvedValue(undefined);

    await handleScheduledSync();

    expect(mockDeleteCnameRecord).toHaveBeenCalledTimes(1);
    expect(mockDeleteCnameRecord).toHaveBeenCalledWith('zone-1', 'rec-stale');
  });

  it('keeps CNAME records that are present in ACM', async () => {
    mockListAllCertificateCnames.mockResolvedValue(
      new Set(['_abc.example.com', '_def.other.com']),
    );
    mockListAllZoneIds.mockResolvedValue(['zone-1']);
    mockListAcmValidationCnames.mockResolvedValue([
      { id: 'rec-1', name: '_abc.example.com', content: '_x.acm-validations.aws' },
      { id: 'rec-2', name: '_def.other.com', content: '_y.acm-validations.aws' },
    ]);

    await handleScheduledSync();

    expect(mockDeleteCnameRecord).not.toHaveBeenCalled();
  });

  it('continues deleting other records when one deletion fails', async () => {
    mockListAllCertificateCnames.mockResolvedValue(new Set());
    mockListAllZoneIds.mockResolvedValue(['zone-1']);
    mockListAcmValidationCnames.mockResolvedValue([
      { id: 'rec-1', name: '_stale1.example.com', content: '_a.acm-validations.aws' },
      { id: 'rec-2', name: '_stale2.example.com', content: '_b.acm-validations.aws' },
    ]);
    mockDeleteCnameRecord
      .mockRejectedValueOnce(new Error('CloudFlare API error'))
      .mockResolvedValueOnce(undefined);

    await expect(handleScheduledSync()).resolves.not.toThrow();
    expect(mockDeleteCnameRecord).toHaveBeenCalledTimes(2);
  });
});
