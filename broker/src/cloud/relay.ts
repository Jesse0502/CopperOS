// Every WebSocket event: connects, disconnects and messages. Connects and
// disconnects are recorded so the backend can reach a user's extension.
// Messages are answered here when quick (chat list, settings, answers) or
// handed to the agent Lambda (tasks) — step 7 of the rollout; for now a
// message gets a pong or a "not open yet" notice, so the whole path from
// sign-in to socket to database can be deployed and checked end to end.

import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const socket = new ApiGatewayManagementApiClient({ endpoint: process.env.SOCKET_CALLBACK_URL });
const CONNECTIONS = process.env.CONNECTIONS_TABLE!;

// API Gateway closes a WebSocket after 2 hours regardless, so a record older
// than that is a connection whose disconnect was missed.
const CONNECTION_TTL_S = 3 * 60 * 60;

/** $connect carries what the authorizer said about the user. */
type Event = APIGatewayProxyWebsocketEventV2 & {
  requestContext: { authorizer?: { userId?: string } };
};

async function post(connectionId: string, message: unknown): Promise<void> {
  try {
    await socket.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(message) }),
    );
  } catch (err) {
    // Closed between its message and our reply: nothing to answer.
    if (!(err instanceof GoneException)) throw err;
  }
}

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId } = event.requestContext;

  if (routeKey === "$connect") {
    const userId = event.requestContext.authorizer?.userId;
    if (!userId) return { statusCode: 401 };
    const now = Math.floor(Date.now() / 1000);
    await db.send(
      new PutCommand({
        TableName: CONNECTIONS,
        Item: { connectionId, userId, kind: "extension", connectedAt: now, expiresAt: now + CONNECTION_TTL_S },
      }),
    );
    return { statusCode: 200 };
  }

  if (routeKey === "$disconnect") {
    await db.send(new DeleteCommand({ TableName: CONNECTIONS, Key: { connectionId } }));
    return { statusCode: 200 };
  }

  let message: { type?: string } = {};
  try {
    message = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400 };
  }
  if (message.type === "ping") {
    await post(connectionId, { type: "pong" });
  } else {
    await post(connectionId, {
      type: "agent_event",
      event: "error",
      chatId: null,
      text: "CopperOS in the cloud is not open yet.",
    });
  }
  return { statusCode: 200 };
}
