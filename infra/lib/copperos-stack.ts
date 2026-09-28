// Everything the hosted CopperOS backend runs on, for one stage (dev, prod).
//
//   extension ──wss──► API Gateway WebSocket ──$connect──► authorizer λ (Cognito token)
//                            │ every message
//                            ▼
//                        relay λ ──async──► agent λ (up to 15 min)
//                            │                 │
//                            ▼                 ▼
//                  DynamoDB tables · S3 transcripts · KMS for users' API keys
//
// Sign-in is Cognito's hosted page: email one-time codes sent through SES
// from the verified domain, and Google once `google` is switched on. The
// Lambda code lives in broker/src/cloud/ and shares the agent core with the
// local broker.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

const BROKER = path.resolve(import.meta.dirname, "../../broker");
// The sign-in page's look: Cognito's own design recoloured to CopperOS's
// copper and warm greys, with its logo (see infra/sign-in/).
const SIGN_IN = path.resolve(import.meta.dirname, "../sign-in");

export type CopperStackProps = StackProps & {
  stage: string;
  /** Offer "Continue with Google" — needs the copperos/google-oauth secret. */
  google: boolean;
  /** The Chrome Web Store extension id: its chromiumapp.org URL is where sign-in returns. */
  extensionId: string;
  /** Unpacked development copies' ids, allowed to sign in to non-prod stacks too. */
  devExtensionIds: string[];
  /** SES-verified domain the sign-in emails come from. */
  emailDomain: string;
  /** Where alarms go. */
  alertEmail: string;
  /** Where "Send a suggestion" from the extension goes. */
  feedbackEmail: string;
  /** Deploy the scripted test model (broker/src/cloud/testing/) — never in prod. */
  testModel: boolean;
};

export class CopperStack extends Stack {
  constructor(scope: Construct, id: string, props: CopperStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const prod = stage === "prod";
    // Dev data is disposable; prod data is kept even if the stack goes.
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const name = (part: string) => `copperos-${stage}-${part}`;

    // ── sign-in ──────────────────────────────────────────────────────────
    const users = new cognito.UserPool(this, "Users", {
      userPoolName: name("users"),
      // Email one-time codes need Essentials, and SES to send them.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Cognito always keeps passwords as an option; the sign-in page leads
      // with the emailed code.
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: `no-reply@${props.emailDomain}`,
        fromName: "CopperOS",
        sesRegion: this.region,
        sesVerifiedDomain: props.emailDomain,
      }),
      deletionProtection: prod,
      removalPolicy,
    });

    let google: cognito.UserPoolIdentityProviderGoogle | null = null;
    if (props.google) {
      const oauth = "copperos/google-oauth";
      google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
        userPool: users,
        clientId: SecretValue.secretsManager(oauth, { jsonField: "client_id" }).unsafeUnwrap(),
        clientSecretValue: SecretValue.secretsManager(oauth, { jsonField: "client_secret" }),
        scopes: ["openid", "email", "profile"],
        attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL },
      });
    }

    // Cognito's hosted sign-in page, in CopperOS's look (SignInStyle below):
    // copperos.auth… for prod, copperos-<stage>.auth… for the others.
    const signIn = users.addDomain("SignIn", {
      cognitoDomain: { domainPrefix: prod ? "copperos" : `copperos-${stage}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // chrome.identity.launchWebAuthFlow returns to the extension's own URL —
    // the store copy's, and on a dev stack any unpacked copy's too.
    const extensionUrls = [props.extensionId, ...(prod ? [] : props.devExtensionIds)].map(
      (id) => `https://${id}.chromiumapp.org/`,
    );
    const client = users.addClient("Extension", {
      userPoolClientName: "extension",
      // A browser extension cannot keep a secret; PKCE protects the code instead.
      generateSecret: false,
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: extensionUrls,
        logoutUrls: extensionUrls,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        ...(google ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : []),
      ],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });
    if (google) client.node.addDependency(google);

    // The newer managed login pages render only once a style is assigned.
    const asset = (category: string, file: string, extension: string) =>
      (["LIGHT", "DARK"] as const).map((colorMode) => ({
        category,
        colorMode,
        extension,
        bytes: readFileSync(path.join(SIGN_IN, file)).toString("base64"),
      }));
    new cognito.CfnManagedLoginBranding(this, "SignInStyle", {
      userPoolId: users.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: false,
      settings: JSON.parse(readFileSync(path.join(SIGN_IN, "style.json"), "utf8")),
      assets: [...asset("FORM_LOGO", "logo.png", "PNG"), ...asset("FAVICON_ICO", "favicon.ico", "ICO")],
    });

    // ── storage ──────────────────────────────────────────────────────────
    const table = (id: string, sortKey?: string) =>
      new dynamodb.TableV2(this, id, {
        tableName: name(id.toLowerCase()),
        partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
        ...(sortKey ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } } : {}),
        billing: dynamodb.Billing.onDemand(),
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
        removalPolicy,
      });
    // Settings, plan and usage, one item per user.
    const usersTable = table("Accounts");
    // One item per fact: sort key is "<topic>/<slug>".
    const memories = table("Memories", "key");
    // One item per chat: its summary, and a paused task's request. The
    // transcript itself is in the bucket.
    const chats = table("Chats", "chatId");
    // A chat's tracked task (progress.ts's TaskState).
    const tasks = table("Tasks", "chatId");
    // Live WebSocket connections: the extension's, and each running task's.
    const connections = new dynamodb.TableV2(this, "Connections", {
      tableName: name("connections"),
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        { indexName: "byUser", partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING } },
      ],
      timeToLiveAttribute: "expiresAt",
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const transcripts = new s3.Bucket(this, "Transcripts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !prod,
    });

    // Encrypts the LLM API keys users bring; the key itself never leaves KMS.
    const userKeys = new kms.Key(this, "UserKeys", {
      alias: name("user-keys"),
      enableKeyRotation: true,
      removalPolicy,
    });

    // Created by hand (a SecureString cannot come from CloudFormation):
    //   aws ssm put-parameter --name /copperos/<stage>/jev-api-key --type SecureString --value …
    const jevParam = `/copperos/${stage}/jev-api-key`;

    // ── functions ────────────────────────────────────────────────────────
    const fn = (id: string, entry: string, opts: Partial<nodejs.NodejsFunctionProps>) =>
      new nodejs.NodejsFunction(this, id, {
        functionName: name(id.toLowerCase()),
        entry: path.join(BROKER, "src/cloud", entry),
        projectRoot: BROKER,
        depsLockFilePath: path.join(BROKER, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: "node22",
          mainFields: ["module", "main"],
          sourceMap: true,
          // Some dependencies still call require(); give the ESM bundle one.
          banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...opts,
      });

    const authorizerFn = fn("Authorize", "authorize.ts", {
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        USER_POOL_ID: users.userPoolId,
        CLIENT_ID: client.userPoolClientId,
        CONNECTIONS_TABLE: connections.tableName,
      },
    });
    // Spends the one-time passes running tasks join the socket with.
    connections.grantReadWriteData(authorizerFn);

    const shared = {
      STAGE: stage,
      ACCOUNTS_TABLE: usersTable.tableName,
      MEMORIES_TABLE: memories.tableName,
      CHATS_TABLE: chats.tableName,
      TASKS_TABLE: tasks.tableName,
      CONNECTIONS_TABLE: connections.tableName,
      TRANSCRIPTS_BUCKET: transcripts.bucketName,
      USER_KEYS_KEY: userKeys.keyArn,
      JEV_PARAM: jevParam,
      // Nobody's Ollama is reachable from here.
      LLM_PROVIDER: "openrouter",
      // A task's active time on the free plan.
      TASK_LIMIT_MS: String(15 * 60_000),
    };

    const agentFn = fn("Agent", "agent-handler.ts", {
      memorySize: 512,
      timeout: Duration.minutes(15),
      environment: shared,
      // Never run a task twice by itself: a retry would repeat what the
      // first attempt already did in the user's browser.
      retryAttempts: 0,
    });

    const relayFn = fn("Relay", "relay.ts", {
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: { ...shared, AGENT_FUNCTION: agentFn.functionName, USER_POOL_ID: users.userPoolId },
    });
    // "Delete my account" removes the sign-in too.
    relayFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:ListUsers", "cognito-idp:AdminDeleteUser"],
        resources: [users.userPoolArn],
      }),
    );

    for (const f of [relayFn, agentFn]) {
      for (const t of [usersTable, memories, chats, tasks, connections]) t.grantReadWriteData(f);
      transcripts.grantReadWrite(f);
      userKeys.grantEncryptDecrypt(f);
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${jevParam}`],
        }),
      );
    }
    agentFn.grantInvoke(relayFn);

    // "Send a suggestion": a public URL, since people running CopperOS on
    // their own computer have no sign-in. It rate-limits itself.
    const feedbackFn = fn("Feedback", "feedback.ts", {
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        USER_POOL_ID: users.userPoolId,
        CLIENT_ID: client.userPoolClientId,
        CONNECTIONS_TABLE: connections.tableName,
        FROM_ADDRESS: `no-reply@${props.emailDomain}`,
        FEEDBACK_TO: props.feedbackEmail,
      },
    });
    connections.grantReadWriteData(feedbackFn);
    feedbackFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cognito-idp:ListUsers"], resources: [users.userPoolArn] }),
    );
    feedbackFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        // The sending identity's default configuration set is checked too.
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
        ],
        conditions: { StringEquals: { "ses:FromAddress": `no-reply@${props.emailDomain}` } },
      }),
    );
    const feedbackUrl = feedbackFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // ── the socket ───────────────────────────────────────────────────────
    // Browsers cannot set headers on a WebSocket, so the Cognito access
    // token comes in the query string.
    const authorizer = new WebSocketLambdaAuthorizer("CognitoToken", authorizerFn, {
      identitySource: ["route.request.querystring.token"],
    });
    const socket = new apigw.WebSocketApi(this, "Socket", {
      apiName: name("socket"),
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("Connect", relayFn), authorizer },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("Disconnect", relayFn) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration("Message", relayFn) },
    });
    const socketStage = new apigw.WebSocketStage(this, "SocketStage", {
      webSocketApi: socket,
      stageName: stage,
      autoDeploy: true,
    });
    socket.grantManageConnections(relayFn);
    socket.grantManageConnections(agentFn);
    const callbackUrl = socketStage.callbackUrl;
    relayFn.addEnvironment("SOCKET_CALLBACK_URL", callbackUrl);
    agentFn.addEnvironment("SOCKET_CALLBACK_URL", callbackUrl);
    agentFn.addEnvironment("SOCKET_URL", socketStage.url);

    // ── alarms ───────────────────────────────────────────────────────────
    const alerts = new sns.Topic(this, "Alerts", { topicName: name("alerts") });
    alerts.addSubscription(new EmailSubscription(props.alertEmail));
    // SES's own review points: above 5% bounces or 0.1% complaints puts the
    // account at risk, so these warn well before AWS would act.
    const ses = (metricName: string, threshold: number, id: string) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: name(id.toLowerCase()),
        metric: new cloudwatch.Metric({
          namespace: "AWS/SES",
          metricName,
          statistic: "Maximum",
          period: Duration.hours(1),
        }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alerts));
    ses("Reputation.BounceRate", 0.04, "EmailBounces");
    ses("Reputation.ComplaintRate", 0.0008, "EmailComplaints");
    // Any function failing outright — not a task's own error, which the
    // agent reports to the user, but a crash or a timeout.
    for (const [id, f] of [["Authorize", authorizerFn], ["Relay", relayFn], ["Agent", agentFn], ["Feedback", feedbackFn]] as const) {
      new cloudwatch.Alarm(this, `${id}Errors`, {
        alarmName: name(`${id.toLowerCase()}-errors`),
        metric: f.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alerts));
    }

    // ── what the extension needs to know ─────────────────────────────────
    new CfnOutput(this, "SocketUrl", { value: socketStage.url });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "ClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "SignInUrl", { value: signIn.baseUrl() });
    new CfnOutput(this, "FeedbackUrl", { value: feedbackUrl.url });

    // ── dev only: the scripted test model ───────────────────────────────
    if (props.testModel && !prod) {
      const fakeModel = fn("FakeModel", "testing/fake-model.ts", {
        memorySize: 128,
        timeout: Duration.seconds(10),
      });
      const url = fakeModel.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      new CfnOutput(this, "TestModelUrl", { value: url.url });
    }
  }
}
