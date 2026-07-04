import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentcore = new BedrockAgentCoreClient({}); // Lambdaと同じリージョンを自動使用
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = String(claims.sub);
  const rawToken = (event.headers.authorization ?? '').replace(
    /^Bearer\s+/i,
    ''
  );

  if (event.rawPath === '/auth/pending') {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 900,
        },
      })
    );
    return json(200, { status: 'ok' });
  }

  if (event.rawPath === '/auth/complete') {
    const { session_id: sessionId } = JSON.parse(event.body ?? '{}');
    if (!sessionId) {
      return json(400, { error: 'session_id is required' });
    }

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { userId },
          UpdateExpression: 'SET #st = :completed, boundAt = :now',
          ConditionExpression: '#st = :pending AND #ttl > :nowEpoch',
          ExpressionAttributeNames: { '#st': 'status', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':completed': 'COMPLETED',
            ':pending': 'PENDING',
            ':now': new Date().toISOString(),
            ':nowEpoch': Math.floor(Date.now() / 1000),
          },
        })
      );
    } catch {
      return json(403, { error: '有効な認可フローが見つかりません' });
    }

    try {
      await agentcore.send(
        new CompleteResourceTokenAuthCommand({
          sessionUri: sessionId,
          userIdentifier: { userToken: rawToken },
        })
      );
    } catch (e) {
      // 失敗したらワンタイム消費を取り消し、再試行できるようにする
      console.error('CompleteResourceTokenAuth failed', e);
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { userId },
          UpdateExpression: 'SET #st = :pending',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':pending': 'PENDING' },
        })
      );
      return json(500, { error: 'GitHub連携の完了処理に失敗しました' });
    }
    return json(200, { status: 'bound' });
  }

  return json(404, { error: 'not found' });
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
