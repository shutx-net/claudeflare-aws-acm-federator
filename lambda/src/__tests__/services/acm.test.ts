// Uses jest.resetModules() + require() to get a fresh module (and fresh ACMClient singleton)
// per test, avoiding cross-test state leakage.

type AcmService = typeof import('../../services/acm');

let acm: AcmService;
let mockSend: jest.Mock;

beforeEach(() => {
  mockSend = jest.fn();

  jest.resetModules();
  jest.mock('@aws-sdk/client-acm', () => ({
    ACMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    DescribeCertificateCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    ListCertificatesCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    CertificateStatus: { PENDING_VALIDATION: 'PENDING_VALIDATION' },
  }));

  acm = require('../../services/acm') as AcmService;
});

afterEach(() => {
  jest.useRealTimers();
});

const CERT_ARN = 'arn:aws:acm:ap-northeast-1:123:certificate/test';

const certWithCnames = {
  Certificate: {
    DomainName: 'example.com',
    DomainValidationOptions: [
      {
        ResourceRecord: {
          Type: 'CNAME',
          Name: '_abc123.example.com.',
          Value: '_def456.acm-validations.aws.',
        },
      },
    ],
  },
};

describe('describeCertificate', () => {
  it('returns CertificateInfo with CNAME records', async () => {
    mockSend.mockResolvedValueOnce(certWithCnames);

    const result = await acm.describeCertificate(CERT_ARN);

    expect(result.arn).toBe(CERT_ARN);
    expect(result.domainName).toBe('example.com');
    expect(result.cnameRecords).toHaveLength(1);
    expect(result.cnameRecords[0]).toEqual({
      name: '_abc123.example.com.',
      value: '_def456.acm-validations.aws.',
    });
  });

  it('retries when CNAME records are not available on first attempt', async () => {
    jest.useFakeTimers();

    mockSend
      .mockResolvedValueOnce({ Certificate: { DomainName: 'example.com', DomainValidationOptions: [] } })
      .mockResolvedValueOnce(certWithCnames);

    const promise = acm.describeCertificate(CERT_ARN);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.cnameRecords).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries if no CNAME records become available', async () => {
    jest.useFakeTimers();

    mockSend.mockResolvedValue({
      Certificate: { DomainName: 'example.com', DomainValidationOptions: [] },
    });

    const promise = acm.describeCertificate(CERT_ARN);
    // Attach the rejection handler BEFORE advancing timers to avoid unhandled rejection warning.
    const assertion = expect(promise).rejects.toThrow(
      `No CNAME validation records available for ${CERT_ARN} after retries`,
    );

    await jest.runAllTimersAsync();
    await assertion;

    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('throws immediately when certificate is not found', async () => {
    mockSend.mockResolvedValueOnce({ Certificate: undefined });

    await expect(acm.describeCertificate(CERT_ARN)).rejects.toThrow(
      `Certificate not found: ${CERT_ARN}`,
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('listPendingCertificates', () => {
  it('returns certificate ARNs from a single page', async () => {
    mockSend.mockResolvedValueOnce({
      CertificateSummaryList: [{ CertificateArn: 'arn:cert1' }, { CertificateArn: 'arn:cert2' }],
    });

    const result = await acm.listPendingCertificates();

    expect(result).toEqual(['arn:cert1', 'arn:cert2']);
  });

  it('handles pagination and returns ARNs from all pages', async () => {
    mockSend
      .mockResolvedValueOnce({
        CertificateSummaryList: [{ CertificateArn: 'arn:cert1' }],
        NextToken: 'page-2-token',
      })
      .mockResolvedValueOnce({
        CertificateSummaryList: [{ CertificateArn: 'arn:cert2' }],
      });

    const result = await acm.listPendingCertificates();

    expect(result).toEqual(['arn:cert1', 'arn:cert2']);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('listAllCertificateCnames', () => {
  it('returns a Set of CNAME names with trailing dots stripped', async () => {
    mockSend
      .mockResolvedValueOnce({
        CertificateSummaryList: [
          { CertificateArn: 'arn:cert1' },
          { CertificateArn: 'arn:cert2' },
        ],
      })
      .mockResolvedValueOnce({
        Certificate: {
          DomainValidationOptions: [
            { ResourceRecord: { Type: 'CNAME', Name: '_abc.example.com.' } },
          ],
        },
      })
      .mockResolvedValueOnce({
        Certificate: {
          DomainValidationOptions: [
            { ResourceRecord: { Type: 'CNAME', Name: '_def.other.com.' } },
          ],
        },
      });

    const result = await acm.listAllCertificateCnames();

    expect(result).toEqual(new Set(['_abc.example.com', '_def.other.com']));
  });

  it('continues and returns partial results when individual describe fails', async () => {
    mockSend
      .mockResolvedValueOnce({
        CertificateSummaryList: [
          { CertificateArn: 'arn:cert1' },
          { CertificateArn: 'arn:cert2' },
        ],
      })
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce({
        Certificate: {
          DomainValidationOptions: [
            { ResourceRecord: { Type: 'CNAME', Name: '_ok.example.com.' } },
          ],
        },
      });

    const result = await acm.listAllCertificateCnames();

    expect(result).toEqual(new Set(['_ok.example.com']));
  });
});
