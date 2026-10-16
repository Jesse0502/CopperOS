// Everything the hosted CopperOS backend runs on, for one stage (dev, prod).
//
//   extension ──wss──► API Gateway WebSocket ──$connect──► authorizer λ (Cognito token)
//                            │ every message
//                            ▼
//                        relay λ ──async──► agent λ (up to 15 min)
//                            │                 │
//                            ▼                 ▼
//                  DynamoDB tables · S3 transcripts · Parameter Store keys
//
//   AI app ──https──► MCP λ (Function URL; signs people in, then acts as them) ──async──► agent λ
//
// A user with no API key of their own runs on CopperOS's model, on a key kept
// in Parameter Store, and what each call costs is charged to their weekly
// allowance and credits (Usage and Accounts tables; broker/src/cloud/billing.ts).

// Sign-in is Cognito's hosted page: email one-time codes sent through SES
// from the verified domain, and Google once `google` is switched on. The
// Lambda code lives in broker/src/cloud/ and shares the agent core with the
// local broker.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CfnDynamicReference,
  CfnDynamicReferenceService,
  CfnOutput,
  CfnParameter,
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
  /** Offer "Continue with Google": needs the /copperos/google-oauth/ parameters. */
  google: boolean;
  /** The Chrome Web Store extension id: its chromiumapp.org URL is where sign-in returns. */
  extensionId: string;
  /** Unpacked development copies' ids, allowed to sign in to non-prod stacks too. */
  devExtensionIds: string[];
  /** SES-verified domain the sign-in emails come from. */
  emailDomain: string;
  /**
   * Offer the emailed one-time code on the sign-in page, beside Google.
   * Needs SES out of the sandbox, or codes reach only verified addresses.
   */
  emailSignIn: boolean;
  /** Where alarms go. */
  alertEmail: string;
  /** Where "Send a suggestion" from the extension goes. */
  feedbackEmail: string;
  /**
   * Dollars of CopperOS's model an Ore (free) account may use per week, and
   * the most the free plan may cost everyone together per calendar month.
   * They start the stage on these numbers; changing either later needs no
   * deploy (see ledger.ts).
   */
  freeWeeklyUsd: number;
  freePoolMonthlyUsd: number;
  /** Deploy the scripted test model (broker/src/cloud/testing/) — never in prod. */
  testModel: boolean;
  /**
   * Lambda concurrency kept for the public MCP endpoint, and so the most it can use of the
   * account's: a flood at its address then cannot starve the agent. AWS requires 100 left
   * unreserved. The account's limit was 50 until 2026-10-17, when the increase to 1000 came
   * through; bin/copperos.ts reserves 100 on prod. Unset: no reservation.
   */
  mcpReservedConcurrency?: number;
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
      // Both live in Parameter Store, which is free, where a Secrets Manager
      // secret is $0.40 a month. The client id is public (it is in every
      // sign-in URL), so CloudFormation reads it from a plain parameter. The
      // secret is a SecureString, which CloudFormation cannot hand to Cognito,
      // so the deploy passes it in as a NoEcho parameter: masked everywhere,
      // never in the template, and reused by later deploys. Created by hand:
      //   aws ssm put-parameter --name /copperos/google-oauth/client-id --type String --value …
      //   aws ssm put-parameter --name /copperos/google-oauth/client-secret --type SecureString --value …
      // and passed once per stage, on its first deploy with this parameter:
      //   npx cdk deploy … --parameters GoogleClientSecret="$(aws ssm get-parameter --name /copperos/google-oauth/client-secret --with-decryption --query Parameter.Value --output text --profile jassydev)"
      const clientSecret = new CfnParameter(this, "GoogleClientSecret", {
        type: "String",
        noEcho: true,
        description: "The Google OAuth client secret, from /copperos/google-oauth/client-secret",
      });
      google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
        userPool: users,
        clientId: new CfnDynamicReference(CfnDynamicReferenceService.SSM, "/copperos/google-oauth/client-id").toString(),
        clientSecretValue: SecretValue.cfnParameter(clientSecret),
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
      // Without email sign-in the page shows only "Continue with Google".
      supportedIdentityProviders: [
        ...(props.emailSignIn || !google ? [cognito.UserPoolClientIdentityProvider.COGNITO] : []),
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
    const signInStyle = (id: string, clientId: string) =>
      new cognito.CfnManagedLoginBranding(this, id, {
        userPoolId: users.userPoolId,
        clientId,
        useCognitoProvidedValues: false,
        settings: JSON.parse(readFileSync(path.join(SIGN_IN, "style.json"), "utf8")),
        assets: [...asset("FORM_LOGO", "logo.png", "PNG"), ...asset("FAVICON_ICO", "favicon.ico", "ICO")],
      });
    signInStyle("SignInStyle", client.userPoolClientId);

    // ── storage ──────────────────────────────────────────────────────────
    const table = (id: string, sortKey?: string, timeToLive?: string) =>
      new dynamodb.TableV2(this, id, {
        tableName: name(id.toLowerCase()),
        partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
        ...(sortKey ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } } : {}),
        ...(timeToLive ? { timeToLiveAttribute: timeToLive } : {}),
        billing: dynamodb.Billing.onDemand(),
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
        removalPolicy,
      });
    // Settings, plan and credits, one item per user. It also holds two kinds of
    // item for payments: the link from a Stripe customer back to a user, and a
    // claim on each credit purchase so one is never granted twice. Claims carry
    // an expiry, which is what the time-to-live is for.
    const usersTable = table("Accounts", undefined, "expiresAt");
    // What each user spent of CopperOS's model, one item per week; old weeks expire.
    const usage = table("Usage", "week", "expiresAt");
    // One item per fact: sort key is "<topic>/<slug>".
    const memories = table("Memories", "key");
    // One item per saved workflow: a name and the steps to run it again.
    const workflows = table("Workflows", "id");
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

    // What the MCP endpoint remembers between requests: apps that registered, sign-ins
    // under way, and hashes of the tokens it issued (broker/src/cloud/mcp-store.ts).
    // Everything in it expires, and a person simply signs in again if it is lost.
    const mcpAuth = new dynamodb.TableV2(this, "McpAuth", {
      tableName: name("mcpauth"),
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
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

    // Created by hand (a SecureString cannot come from CloudFormation):
    //   aws ssm put-parameter --name /copperos/<stage>/jev-api-key --type SecureString --value …
    //   aws ssm put-parameter --name /copperos/<stage>/user-keys-secret --type SecureString --value "$(openssl rand -base64 32)"
    // The second seals the LLM API keys users bring (broker/src/store/cloud.ts).
    const jevParam = `/copperos/${stage}/jev-api-key`;
    const userKeysParam = `/copperos/${stage}/user-keys-secret`;
    // The OpenRouter key every user on CopperOS's own model runs on. Give it a
    // credit limit on OpenRouter's side too: that, not this stack, is the hard
    // ceiling on what the model can cost.
    //   aws ssm put-parameter --name /copperos/<stage>/openrouter-key --type SecureString --value sk-or-…
    const platformKeyParam = `/copperos/${stage}/openrouter-key`;
    // Optional, plain text: the weekly allowance of each plan, changed without a deploy.
    //   aws ssm put-parameter --name /copperos/<stage>/limits --type String --overwrite \
    //     --value '{"ore":1.5,"ingot":4,"facet":10,"freePool":40}'
    const limitsParam = `/copperos/${stage}/limits`;
    // Optional, plain text: how long a task may run on each plan, and how much working time a
    // week holds (broker/src/cloud/runtime.ts). null means no limit.
    //   aws ssm put-parameter --name /copperos/<stage>/runtime --type String --overwrite \
    //     --value '{"ingot":{"taskMinutes":300},"foundry":{"weeklyHours":8}}'
    const runtimeParam = `/copperos/${stage}/runtime`;
    // Stripe. Both are put there by `npm run stripe:setup -- --stage <stage>` (see
    // the README): the secret key by every run, the webhook's signing secret when
    // the webhook is registered. Neither is ever sent to the extension.
    const stripeKeyParam = `/copperos/${stage}/stripe-secret-key`;
    const stripeWebhookParam = `/copperos/${stage}/stripe-webhook-secret`;

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
      USAGE_TABLE: usage.tableName,
      WORKFLOWS_TABLE: workflows.tableName,
      CONNECTIONS_TABLE: connections.tableName,
      TRANSCRIPTS_BUCKET: transcripts.bucketName,
      USER_KEYS_PARAM: userKeysParam,
      JEV_PARAM: jevParam,
      PLATFORM_KEY_PARAM: platformKeyParam,
      LIMITS_PARAM: limitsParam,
      RUNTIME_PARAM: runtimeParam,
      FREE_WEEKLY_USD: String(props.freeWeeklyUsd),
      FREE_POOL_MONTHLY_USD: String(props.freePoolMonthlyUsd),
      // Nobody's Ollama is reachable from here.
      LLM_PROVIDER: "openrouter",
      // A task's active time on the free plan.
      TASK_LIMIT_MS: String(15 * 60_000),
    };

    // A task longer than one Lambda's 15 minutes is handed to a new one by the agent itself
    // (agent-run.ts), so the agent needs to know its own name. The name is built here, not
    // read from the function, because a function cannot depend on a policy that names it.
    const agentName = name("agent");
    const agentFn = fn("Agent", "agent-handler.ts", {
      memorySize: 512,
      timeout: Duration.minutes(15),
      environment: { ...shared, AGENT_FUNCTION_NAME: agentName },
      // Never run a task twice by itself: a retry would repeat what the
      // first attempt already did in the user's browser.
      retryAttempts: 0,
    });

    const relayFn = fn("Relay", "relay.ts", {
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        ...shared,
        AGENT_FUNCTION: agentFn.functionName,
        USER_POOL_ID: users.userPoolId,
        STRIPE_SECRET_PARAM: stripeKeyParam,
      },
    });
    // "Delete my account" removes the sign-in too.
    relayFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:ListUsers", "cognito-idp:AdminDeleteUser"],
        resources: [users.userPoolArn],
      }),
    );

    const parameterArn = (p: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${p}`;
    for (const f of [relayFn, agentFn]) {
      for (const t of [usersTable, memories, workflows, chats, tasks, usage, connections]) t.grantReadWriteData(f);
      transcripts.grantReadWrite(f);
      // The model key stays out of the relay, which never calls the model.
      // Only the relay talks to Stripe (to open the payment page); the agent never does.
      const params = [
        jevParam,
        userKeysParam,
        limitsParam,
        runtimeParam,
        ...(f === agentFn ? [platformKeyParam] : [stripeKeyParam]),
      ];
      f.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: params.map(parameterArn) }),
      );
    }
    agentFn.grantInvoke(relayFn);
    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${agentName}`],
      }),
    );

    // ── the MCP endpoint ─────────────────────────────────────────────────
    // Where an AI app (Claude's custom connectors, any MCP client) is pointed to use a
    // person's CopperOS: a public URL that signs people in itself (cloud/mcp-oauth.ts) and
    // answers only to the tokens it issued. It starts tasks the way the relay does, and
    // never calls the model, so it has no model key.
    const mcpFn = fn("Mcp", "mcp.ts", {
      memorySize: 512,
      timeout: Duration.seconds(30),
      ...(props.mcpReservedConcurrency ? { reservedConcurrentExecutions: props.mcpReservedConcurrency } : {}),
      environment: {
        ...shared,
        AGENT_FUNCTION: agentFn.functionName,
        USER_POOL_ID: users.userPoolId,
        SIGN_IN_URL: signIn.baseUrl(),
        MCP_AUTH_TABLE: mcpAuth.tableName,
      },
    });
    for (const t of [usersTable, memories, workflows, chats, tasks, usage, connections, mcpAuth]) t.grantReadWriteData(mcpFn);
    transcripts.grantReadWrite(mcpFn);
    mcpFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [jevParam, userKeysParam, limitsParam, runtimeParam].map(parameterArn),
      }),
    );
    agentFn.grantInvoke(mcpFn);
    // The sign-in finds its own app client by name (cloud/mcp-cognito.ts): the client's
    // return address is this function's URL, so the function cannot be handed the client.
    mcpFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cognito-idp:ListUserPoolClients"], resources: [users.userPoolArn] }),
    );
    const mcpUrl = mcpFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // Account deletion removes the tokens an AI app holds.
    relayFn.addEnvironment("MCP_AUTH_TABLE", mcpAuth.tableName);
    // Settings → MCP shows the address to add in Claude, and lists and disconnects the apps.
    relayFn.addEnvironment("MCP_URL", `${mcpUrl.url}mcp`);
    mcpAuth.grantReadWriteData(relayFn);

    // The sign-in an AI app starts goes through the same page as the extension's, with its own
    // return address. Only the code is used; a person's CopperOS token is never handed to the app.
    const mcpClient = users.addClient("Mcp", {
      userPoolClientName: "mcp",
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${mcpUrl.url}callback`],
        logoutUrls: [mcpUrl.url],
      },
      supportedIdentityProviders: [
        ...(props.emailSignIn || !google ? [cognito.UserPoolClientIdentityProvider.COGNITO] : []),
        ...(google ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : []),
      ],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(1),
      preventUserExistenceErrors: true,
    });
    if (google) mcpClient.node.addDependency(google);
    signInStyle("McpSignInStyle", mcpClient.userPoolClientId);

    // Stripe calls this when money moves: a subscription began or ended, a month
    // was paid, a credit pack was bought. It is public because Stripe is the
    // caller, and it trusts nothing it is not able to verify: every request has
    // to carry a signature made with the secret only Stripe and this function
    // know (broker/src/cloud/stripe-webhook.ts). Until that secret is stored it
    // answers 503, and Stripe retries.
    const stripeWebhookFn = fn("StripeWebhook", "stripe-webhook.ts", {
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        STAGE: stage,
        ACCOUNTS_TABLE: usersTable.tableName,
        STRIPE_SECRET_PARAM: stripeKeyParam,
        STRIPE_WEBHOOK_PARAM: stripeWebhookParam,
      },
    });
    // It changes plans and credits, which live in the Accounts table and nowhere else.
    usersTable.grantReadWriteData(stripeWebhookFn);
    stripeWebhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [stripeKeyParam, stripeWebhookParam].map(parameterArn),
      }),
    );
    const stripeWebhookUrl = stripeWebhookFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

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

    // The welcome email: Cognito runs it once a person has signed up (an emailed code, or the first
    // sign-in with Google) and it sends the email from broker/src/cloud/welcome-email.ts. It must
    // never fail the sign-up, so it catches everything. It is not told the pool, which depends on it.
    const welcomeFn = fn("Welcome", "welcome.ts", {
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: {
        ACCOUNTS_TABLE: usersTable.tableName,
        FROM_ADDRESS: `no-reply@${props.emailDomain}`,
        REPLY_TO: props.feedbackEmail,
      },
    });
    usersTable.grantReadWriteData(welcomeFn);
    welcomeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
        ],
        conditions: { StringEquals: { "ses:FromAddress": `no-reply@${props.emailDomain}` } },
      }),
    );
    users.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, welcomeFn);

    // Where the Unsubscribe link in the "what's new" emails goes (broker/src/cloud/unsubscribe.ts). A
    // public address, safe to be: a link only works for the person it was made for, by a signature
    // made with the same secret the stored data is sealed with.
    const unsubscribeFn = fn("Unsubscribe", "unsubscribe.ts", {
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { ACCOUNTS_TABLE: usersTable.tableName, USER_KEYS_PARAM: userKeysParam },
    });
    usersTable.grantReadWriteData(unsubscribeFn);
    unsubscribeFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn(userKeysParam)] }),
    );
    const unsubscribeUrl = unsubscribeFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

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
    socket.grantManageConnections(mcpFn);
    const callbackUrl = socketStage.callbackUrl;
    mcpFn.addEnvironment("SOCKET_CALLBACK_URL", callbackUrl);
    relayFn.addEnvironment("SOCKET_CALLBACK_URL", callbackUrl);
    agentFn.addEnvironment("SOCKET_CALLBACK_URL", callbackUrl);
    agentFn.addEnvironment("SOCKET_URL", socketStage.url);

    // ── alarms ───────────────────────────────────────────────────────────
    const alerts = new sns.Topic(this, "Alerts", { topicName: name("alerts") });
    alerts.addSubscription(new EmailSubscription(props.alertEmail));
    // The agent emails the owner as the free pool fills (billing.ts).
    agentFn.addEnvironment("ALERTS_TOPIC_ARN", alerts.topicArn);
    alerts.grantPublish(agentFn);
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
    for (const [id, f] of [["Authorize", authorizerFn], ["Relay", relayFn], ["Agent", agentFn], ["Mcp", mcpFn], ["Welcome", welcomeFn], ["Unsubscribe", unsubscribeFn], ["Feedback", feedbackFn], ["StripeWebhook", stripeWebhookFn]] as const) {
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
    // For `npm run admin -- encrypt`, which reads the chats already stored.
    new CfnOutput(this, "TranscriptsBucket", { value: transcripts.bucketName });
    new CfnOutput(this, "SocketUrl", { value: socketStage.url });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "ClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "SignInUrl", { value: signIn.baseUrl() });
    new CfnOutput(this, "FeedbackUrl", { value: feedbackUrl.url });
    // For `npm run admin -- whats-new`: the address the emails' Unsubscribe links point at.
    new CfnOutput(this, "UnsubscribeUrl", { value: unsubscribeUrl.url });
    // The address to add as a custom connector in Claude (or any MCP client).
    new CfnOutput(this, "McpUrl", { value: `${mcpUrl.url}mcp` });
    // Register this in Stripe: npm run stripe:setup -- --stage <stage> --webhook <this url>
    new CfnOutput(this, "StripeWebhookUrl", { value: stripeWebhookUrl.url });

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
