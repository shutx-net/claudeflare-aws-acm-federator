import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const SECRET_NAME = 'acm-dns-federator/cloudflare-api-token';

export class AcmDnsFederatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Secrets Manager: create secret (initial value set manually after deploy) ---
    // Best practice: do not embed secret values in the CloudFormation template.
    // After deployment, set the value via console or CLI:
    //   aws secretsmanager put-secret-value \
    //     --secret-id acm-dns-federator/cloudflare-api-token \
    //     --secret-string '{"token":"YOUR_CLOUDFLARE_API_TOKEN"}'
    const cfApiTokenSecret = new secretsmanager.Secret(this, 'CloudFlareApiTokenSecret', {
      secretName: SECRET_NAME,
      description:
        'CloudFlare API Token for ACM DNS Federator. Set {"token":"<token>"} after deployment.',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'CloudFlareApiTokenSecretArn', {
      value: cfApiTokenSecret.secretArn,
      description: 'Set {"token":"YOUR_CLOUDFLARE_API_TOKEN"} as the secret value before use.',
    });

    // --- Log Group (30-day retention, explicitly destroyed on stack removal) ---
    const logGroup = new logs.LogGroup(this, 'FederatorLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Lambda function (TypeScript bundled via esbuild) ---
    const federatorFn = new NodejsFunction(this, 'AcmDnsFederatorFunction', {
      entry: path.join(__dirname, '../../lambda/src/index.ts'),
      projectRoot: path.join(__dirname, '../../lambda'),
      depsLockFilePath: path.join(__dirname, '../../lambda/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logGroup,
      environment: {
        SECRET_NAME: cfApiTokenSecret.secretName,
      },
      bundling: {
        // AWS SDK v3 is included in the Node.js 22 Lambda runtime — no need to bundle it.
        externalModules: ['@aws-sdk/*'],
        minify: true,
      },
    });

    cfApiTokenSecret.grantRead(federatorFn);

    // --- IAM: minimal ACM permissions ---
    federatorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['acm:DescribeCertificate', 'acm:ListCertificates'],
        resources: ['*'],
      }),
    );

    // --- Trigger 1: New certificate requested (CloudTrail management event) ---
    // Requires CloudTrail to be enabled in the account with management events logging.
    const certRequestRule = new events.Rule(this, 'CertificateRequestRule', {
      description: 'Trigger DNS sync when a new ACM certificate is requested',
      eventPattern: {
        source: ['aws.cloudtrail'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['acm.amazonaws.com'],
          eventName: ['RequestCertificate'],
        },
      },
    });
    certRequestRule.addTarget(new targets.LambdaFunction(federatorFn));

    // --- Trigger 2: ACM certificate renewal requires manual action ---
    const renewalRule = new events.Rule(this, 'RenewalActionRequiredRule', {
      description: 'Trigger DNS sync when ACM renewal requires action (e.g. missing CNAME)',
      eventPattern: {
        source: ['aws.acm'],
        detailType: ['ACM Certificate Renewal Action Required'],
      },
    });
    renewalRule.addTarget(new targets.LambdaFunction(federatorFn));

    // --- Trigger 3: Daily scheduled sync at 06:00 JST (21:00 UTC) ---
    // Sends a custom payload so the Lambda can identify this as a scheduled sync.
    const dailySyncRule = new events.Rule(this, 'DailySyncRule', {
      description: 'Daily full sync of all PENDING_VALIDATION certificates',
      schedule: events.Schedule.cron({ minute: '0', hour: '21' }),
    });
    dailySyncRule.addTarget(
      new targets.LambdaFunction(federatorFn, {
        event: events.RuleTargetInput.fromObject({ triggerType: 'scheduledSync' }),
      }),
    );
  }
}
