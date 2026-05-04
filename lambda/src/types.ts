export interface CnameRecord {
  name: string;
  value: string;
}

export interface CertificateInfo {
  arn: string;
  domainName: string;
  cnameRecords: CnameRecord[];
}

export interface SchedulerTrigger {
  triggerType: 'scheduledSync';
}

export interface CertificateRequestEvent {
  source: 'aws.cloudtrail';
  'detail-type': 'AWS API Call via CloudTrail';
  detail: {
    responseElements?: {
      certificateArn?: string;
    };
  };
}

export interface RenewalRequiredEvent {
  source: 'aws.acm';
  'detail-type': 'ACM Certificate Renewal Action Required';
  detail: {
    CertificateArn?: string;
  };
}

export type LambdaEvent = SchedulerTrigger | CertificateRequestEvent | RenewalRequiredEvent;
