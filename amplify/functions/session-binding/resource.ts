import { defineFunction } from '@aws-amplify/backend';

export const sessionBinding = defineFunction({
  name: 'session-binding',
  entry: './handler.ts',
  timeoutSeconds: 30,
  // DynamoDBやAPI Gatewayと同じカスタムスタックに同居させる
  // （これが無いと関数用ネストスタックとの間で循環参照が発生する）
  resourceGroupName: 'SessionBindingStack',
});
