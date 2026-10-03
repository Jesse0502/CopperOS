// The account's spending guard, one stack for every stage:
//
//   npx cdk deploy -c stage=guard --profile jassydev
//
// AWS has no hard spending cap, so this makes one. When the month's actual
// bill passes `spendCap` dollars, the budget publishes to a topic, and the
// brake function sets every copperos-* Lambda to zero concurrent runs: cloud
// sign-in and tasks stop until released. Budgets see the bill a few hours to
// a day late, so spending can run past the cap by up to about a day's worth,
// and fixed fees (the DNS zone) carry on regardless. To release the brake:
//
//   aws lambda invoke --function-name copperos-guard-brake --payload '{"release":true}' \
//     --cli-binary-format raw-in-base64-out --profile jassydev /dev/stdout
//
// A budget notification fires once per month when it is crossed, so after a
// release the brake stays off for the rest of that month.
//
// Also: Cost Anomaly Detection, emailing a daily summary of any unusual spend
// over $1. Budgets, anomaly detection, the topic and the function all fit in
// AWS's free tiers.

import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export type GuardStackProps = StackProps & {
  /** The month's actual bill, in USD, at which the brake goes on. */
  spendCap: number;
  /** Where the cap and anomaly emails go. */
  alertEmail: string;
};

// The brake. A direct invoke can name functions with `only` (for testing it on
// one dev function) or pass `release` to undo the brake; the budget's message
// arrives through SNS and brakes them all.
const BRAKE = `
const { LambdaClient, ListFunctionsCommand, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand } = require("@aws-sdk/client-lambda");
const lambda = new LambdaClient({});

exports.handler = async (event) => {
  const only = Array.isArray(event && event.only) ? event.only : null;
  const release = Boolean(event && event.release);
  const names = [];
  let Marker;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker }));
    for (const f of page.Functions || []) {
      if (f.FunctionName.startsWith("copperos-") && f.FunctionName !== process.env.AWS_LAMBDA_FUNCTION_NAME) names.push(f.FunctionName);
    }
    Marker = page.NextMarker;
  } while (Marker);
  const done = [];
  for (const FunctionName of only ? names.filter((n) => only.includes(n)) : names) {
    try {
      await lambda.send(release
        ? new DeleteFunctionConcurrencyCommand({ FunctionName })
        : new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions: 0 }));
      done.push(FunctionName);
    } catch (err) {
      console.error((release ? "could not release " : "could not brake ") + FunctionName + ": " + err);
    }
  }
  console.log((release ? "released: " : "braked: ") + (done.join(", ") || "nothing"));
  return { release, done };
};
`;

export class GuardStack extends Stack {
  constructor(scope: Construct, id: string, props: GuardStackProps) {
    super(scope, id, props);
    const functions = `arn:aws:lambda:${this.region}:${this.account}:function:copperos-*`;

    const brake = new lambda.Function(this, "Brake", {
      functionName: "copperos-guard-brake",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(BRAKE),
      memorySize: 128,
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "BrakeLogs", {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    brake.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:ListFunctions"], resources: ["*"] }));
    brake.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"],
        resources: [functions],
      }),
    );

    // Unencrypted: Budgets cannot publish to a topic under an AWS-managed key.
    const topic = new sns.Topic(this, "CapReached", { topicName: "copperos-guard-cap-reached" });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );
    topic.addSubscription(new LambdaSubscription(brake));

    const email = { subscriptionType: "EMAIL", address: props.alertEmail };
    const cap = new budgets.CfnBudget(this, "Cap", {
      budget: {
        budgetName: "CopperOS spend cap",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.spendCap, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          // A warning first, by email only.
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
          subscribers: [email],
        },
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers: [email, { subscriptionType: "SNS", address: topic.topicArn }],
        },
      ],
    });
    // Budgets checks it may publish when the budget is created.
    cap.node.addDependency(topic);

    const monitor = new ce.CfnAnomalyMonitor(this, "Anomalies", {
      monitorName: "CopperOS services",
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });
    new ce.CfnAnomalySubscription(this, "AnomalyEmails", {
      subscriptionName: "CopperOS anomalies",
      frequency: "DAILY",
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: "EMAIL", address: props.alertEmail }],
      thresholdExpression: JSON.stringify({
        Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["1"] },
      }),
    });
  }
}
