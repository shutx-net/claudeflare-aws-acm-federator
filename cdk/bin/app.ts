import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AcmDnsFederatorStack } from '../lib/stack';

const app = new cdk.App();

new AcmDnsFederatorStack(app, 'AcmDnsFederatorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
