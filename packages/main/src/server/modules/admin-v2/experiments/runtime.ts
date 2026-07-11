import { createHash } from "node:crypto";
import {
  METRIC_PRODUCT_EVENTS,
  experimentAssignmentRequestSchema,
  experimentAssignmentResponseSchema,
  experimentExposureRequestSchema,
  experimentExposureResponseSchema,
  experimentVariantSchema,
  type ExperimentAssignmentRequest,
  type ExperimentAssignmentResponse,
  type ExperimentExposureRequest,
  type ExperimentExposureResponse,
  type ExperimentVariant,
} from "@idream/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "../metrics/projector";
import { classifyCustomerMetricActor } from "../metrics/event-classification";
import { ingestProductEvent } from "../shared/product-event-store";
import { toInputJson } from "../shared/prisma-json";

export class ExperimentRuntimeError extends Error {
  constructor(
    readonly code: "definition_not_running" | "invalid_allocation" | "invalid_eligibility_definition" | "assignment_not_found" | "event_conflict",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function assignmentVersion(experiment: { id: string; version: number }) {
  return `${experiment.id}:v${experiment.version}`;
}

function variantsFrom(value: Prisma.JsonValue): ExperimentVariant[] {
  const parsed = experimentVariantSchema.array().safeParse(value);
  if (!parsed.success || parsed.data.reduce((sum, variant) => sum + variant.allocationBps, 0) !== 10_000) {
    throw new ExperimentRuntimeError(
      "invalid_allocation",
      "Experiment variants must be unique weighted entries totaling 10,000 basis points",
      409,
    );
  }
  if (new Set(parsed.data.map((variant) => variant.key)).size !== parsed.data.length) {
    throw new ExperimentRuntimeError("invalid_allocation", "Experiment variant keys must be unique", 409);
  }
  return parsed.data;
}

function assignedVariant(input: {
  salt: string;
  experimentKey: string;
  experimentVersion: number;
  subjectType: string;
  subjectId: string;
  variants: readonly ExperimentVariant[];
}) {
  const digest = createHash("sha256")
    .update(`${input.salt}\u0000${input.experimentKey}\u0000${input.experimentVersion}\u0000${input.subjectType}\u0000${input.subjectId}`)
    .digest();
  const bucket = digest.readUInt32BE(0) % 10_000;
  let upper = 0;
  for (const variant of input.variants) {
    upper += variant.allocationBps;
    if (bucket < upper) return variant.key;
  }
  throw new ExperimentRuntimeError("invalid_allocation", "Experiment allocation did not cover the assignment bucket", 409);
}

function isEligible(definition: Prisma.JsonValue, snapshot: Readonly<Record<string, unknown>>) {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw new ExperimentRuntimeError(
      "invalid_eligibility_definition",
      "Experiment eligibility must be a field-to-requirement object",
      409,
    );
  }
  return Object.entries(definition).every(([field, requirement]) => {
    const actual = snapshot[field];
    if (Array.isArray(requirement)) {
      if (!requirement.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))) {
        throw new ExperimentRuntimeError("invalid_eligibility_definition", `Unsupported eligibility requirement for ${field}`, 409);
      }
      return requirement.includes(actual as never);
    }
    if (requirement !== null && !["string", "number", "boolean"].includes(typeof requirement)) {
      throw new ExperimentRuntimeError("invalid_eligibility_definition", `Unsupported eligibility requirement for ${field}`, 409);
    }
    return actual === requirement;
  });
}

export async function assignExperiment(
  db: PrismaClient,
  experimentKey: string,
  rawInput: ExperimentAssignmentRequest,
): Promise<ExperimentAssignmentResponse> {
  const input = experimentAssignmentRequestSchema.parse(rawInput);
  const experiment = await db.experimentDefinition.findFirst({
    where: { key: experimentKey, status: "running", ...(input.version ? { version: input.version } : {}) },
    orderBy: { version: "desc" },
  });
  if (!experiment) {
    throw new ExperimentRuntimeError("definition_not_running", "No running experiment definition was found", 404);
  }
  const version = assignmentVersion(experiment);
  if (!isEligible(experiment.eligibility, input.eligibilitySnapshot)) {
    return experimentAssignmentResponseSchema.parse({
      status: "ineligible",
      experimentId: experiment.id,
      experimentKey: experiment.key,
      experimentVersion: experiment.version,
      assignmentId: null,
      assignmentVersion: version,
      variant: null,
      assignedAt: null,
    });
  }

  const variants = variantsFrom(experiment.variants);
  const variant = assignedVariant({
    salt: experiment.salt,
    experimentKey: experiment.key,
    experimentVersion: experiment.version,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    variants,
  });
  const where = {
    experimentId_subjectType_subjectId_assignmentVersion: {
      experimentId: experiment.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      assignmentVersion: version,
    },
  } as const;
  let assignment = await db.experimentAssignment.findUnique({ where });
  if (!assignment) {
    try {
      assignment = await db.experimentAssignment.create({
        data: {
          experimentId: experiment.id,
          experimentVersion: experiment.version,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          assignmentVersion: version,
          variant,
          eligibilitySnapshot: toInputJson(input.eligibilitySnapshot),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      assignment = await db.experimentAssignment.findUnique({ where });
      if (!assignment) throw error;
    }
  }
  return experimentAssignmentResponseSchema.parse({
    status: "assigned",
    experimentId: experiment.id,
    experimentKey: experiment.key,
    experimentVersion: experiment.version,
    assignmentId: assignment.id,
    assignmentVersion: assignment.assignmentVersion,
    variant: assignment.variant,
    assignedAt: assignment.assignedAt.toISOString(),
  });
}

export async function recordExperimentExposure(
  db: PrismaClient,
  rawInput: ExperimentExposureRequest,
  options: { environment: "development" | "test" | "preview" | "production" },
): Promise<ExperimentExposureResponse> {
  const input = experimentExposureRequestSchema.parse(rawInput);
  const assignment = await db.experimentAssignment.findUnique({ where: { id: input.assignmentId } });
  if (!assignment) {
    throw new ExperimentRuntimeError("assignment_not_found", "Exposure requires a persisted assignment", 404);
  }
  const payload = {
    exposureId: input.exposureId,
    assignmentId: assignment.id,
    experimentId: assignment.experimentId,
    experimentVersion: assignment.experimentVersion,
    assignmentVersion: assignment.assignmentVersion,
    subjectType: assignment.subjectType as "user" | "anonymous",
    subjectId: assignment.subjectId,
    variant: assignment.variant,
    eligible: true,
    surface: input.surface,
  } as const;
  const classification = assignment.subjectType === "user"
    ? await classifyCustomerMetricActor(db, assignment.subjectId)
    : {
        dataClass: "customer" as const,
        actor: { type: "anonymous", anonymousId: assignment.subjectId, isInternal: false },
      };
  const ingested = await ingestProductEvent(db, {
    sourceService: "main-experiment-runtime",
    sourceEventId: input.exposureId,
    eventType: METRIC_PRODUCT_EVENTS.experimentExposed,
    schemaVersion: 2,
    occurredAt: new Date(input.occurredAt),
    environment: options.environment,
    dataClass: classification.dataClass,
    trustClass: "typed_client",
    actor: classification.actor,
    context: { surface: input.surface },
    payload,
  });
  if (ingested.status === "quarantined") {
    throw new ExperimentRuntimeError("event_conflict", "Exposure ID was reused with a different payload", 409);
  }
  const event = await db.analyticsEvent.findUniqueOrThrow({
    where: {
      sourceService_sourceEventId: {
        sourceService: "main-experiment-runtime",
        sourceEventId: input.exposureId,
      },
    },
  });
  await projectCanonicalMetricEvent(db, {
    id: event.id,
    sourceService: event.sourceService,
    sourceEventId: event.sourceEventId ?? event.id,
    name: event.name,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt ?? event.createdAt,
    ingestedAt: event.ingestedAt,
    environment: event.environment,
    dataClass: event.dataClass,
    trustClass: event.trustClass,
    actor: event.actor,
    context: event.context,
    props: event.props,
  });
  return experimentExposureResponseSchema.parse({
    status: ingested.status === "duplicate" ? "duplicate" : "recorded",
    exposureId: input.exposureId,
    assignmentId: assignment.id,
    experimentId: assignment.experimentId,
    experimentVersion: assignment.experimentVersion,
    assignmentVersion: assignment.assignmentVersion,
    variant: assignment.variant,
  });
}

function internalAuthorized(request: Request) {
  return request.headers.get("x-internal-token") === env.INTERNAL_TOKEN;
}

function runtimeErrorResponse(error: unknown) {
  if (error instanceof ExperimentRuntimeError) {
    return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json({ ok: false, error: { code: "bad_request", message: "Invalid experiment request" } }, { status: 400 });
  }
  throw error;
}

export async function assignExperimentRequest(request: Request, experimentKey: string) {
  if (!internalAuthorized(request)) {
    return Response.json({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  }
  try {
    const assignment = await assignExperiment(prisma, experimentKey, await request.json());
    return Response.json({ ok: true, data: assignment }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}

export async function recordExperimentExposureRequest(request: Request) {
  if (!internalAuthorized(request)) {
    return Response.json({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  }
  try {
    const exposure = await recordExperimentExposure(prisma, await request.json(), { environment: env.APP_ENV });
    return Response.json({ ok: true, data: exposure }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
