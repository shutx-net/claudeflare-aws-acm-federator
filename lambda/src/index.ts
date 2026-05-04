import { handleCertificateRequest } from './handlers/certificateRequest';
import { handleRenewalRequired } from './handlers/renewalRequired';
import { handleScheduledSync } from './handlers/scheduledSync';
import { LambdaEvent } from './types';

export const handler = async (event: LambdaEvent): Promise<void> => {
  if ('triggerType' in event && event.triggerType === 'scheduledSync') {
    return handleScheduledSync();
  }

  if ('source' in event) {
    if (
      event.source === 'aws.cloudtrail' &&
      event['detail-type'] === 'AWS API Call via CloudTrail'
    ) {
      return handleCertificateRequest(event);
    }

    if (
      event.source === 'aws.acm' &&
      event['detail-type'] === 'ACM Certificate Renewal Action Required'
    ) {
      return handleRenewalRequired(event);
    }
  }

  throw new Error(`Unrecognized event: ${JSON.stringify(event)}`);
};
