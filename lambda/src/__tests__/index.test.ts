import { handleCertificateRequest } from '../handlers/certificateRequest';
import { handleRenewalRequired } from '../handlers/renewalRequired';
import { handleScheduledSync } from '../handlers/scheduledSync';
import { handler } from '../index';

jest.mock('../handlers/certificateRequest');
jest.mock('../handlers/renewalRequired');
jest.mock('../handlers/scheduledSync');

const mockHandleCertificateRequest = jest.mocked(handleCertificateRequest);
const mockHandleRenewalRequired = jest.mocked(handleRenewalRequired);
const mockHandleScheduledSync = jest.mocked(handleScheduledSync);

beforeEach(() => {
  mockHandleCertificateRequest.mockResolvedValue(undefined);
  mockHandleRenewalRequired.mockResolvedValue(undefined);
  mockHandleScheduledSync.mockResolvedValue(undefined);
});

describe('handler', () => {
  it('routes scheduledSync to handleScheduledSync', async () => {
    await handler({ triggerType: 'scheduledSync' });
    expect(mockHandleScheduledSync).toHaveBeenCalledTimes(1);
    expect(mockHandleCertificateRequest).not.toHaveBeenCalled();
    expect(mockHandleRenewalRequired).not.toHaveBeenCalled();
  });

  it('routes CloudTrail RequestCertificate to handleCertificateRequest', async () => {
    const event = {
      source: 'aws.cloudtrail' as const,
      'detail-type': 'AWS API Call via CloudTrail' as const,
      detail: { responseElements: { certificateArn: 'arn:aws:acm:ap-northeast-1:123:certificate/abc' } },
    };
    await handler(event);
    expect(mockHandleCertificateRequest).toHaveBeenCalledWith(event);
    expect(mockHandleScheduledSync).not.toHaveBeenCalled();
  });

  it('routes ACM renewal event to handleRenewalRequired', async () => {
    const event = {
      source: 'aws.acm' as const,
      'detail-type': 'ACM Certificate Renewal Action Required' as const,
      detail: { CertificateArn: 'arn:aws:acm:ap-northeast-1:123:certificate/abc' },
    };
    await handler(event);
    expect(mockHandleRenewalRequired).toHaveBeenCalledWith(event);
    expect(mockHandleScheduledSync).not.toHaveBeenCalled();
  });

  it('throws for unrecognized event', async () => {
    await expect(handler({ source: 'unknown' } as never)).rejects.toThrow('Unrecognized event');
  });
});
