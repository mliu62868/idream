import { Prisma, type ControlPlaneCommand } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  CONTROL_PLANE_COMMAND_STATES,
  isControlPlaneCommandTransitionAllowed,
} from "./state-transition-authority";

type ControlPlaneCommandStatus = (typeof CONTROL_PLANE_COMMAND_STATES)[number];
type CommandUpdate = Omit<Prisma.ControlPlaneCommandUpdateManyMutationInput, "status">;

interface CommandTransitionExpectation {
  readonly from?: ControlPlaneCommandStatus | readonly ControlPlaneCommandStatus[];
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: Date | null;
  readonly attemptCount?: number;
}

interface TransitionControlPlaneCommandInput {
  readonly commandId: string;
  readonly to: ControlPlaneCommandStatus;
  readonly expected?: CommandTransitionExpectation;
  readonly data?: CommandUpdate;
  readonly onConflict?: "throw" | "return-null";
}

interface UpdateControlPlaneCommandMetadataInput {
  readonly commandId: string;
  readonly expected?: CommandTransitionExpectation;
  readonly data: CommandUpdate;
  readonly onConflict?: "throw" | "return-null";
}

function expectedStates(expected: CommandTransitionExpectation | undefined) {
  if (!expected?.from) return null;
  return Array.isArray(expected.from) ? expected.from : [expected.from];
}

function matchesExpectation(
  current: {
    readonly status: string;
    readonly leaseOwner: string | null;
    readonly leaseExpiresAt: Date | null;
    readonly attemptCount: number;
  },
  expected: CommandTransitionExpectation | undefined,
) {
  const states = expectedStates(expected);
  if (states && !states.includes(current.status as ControlPlaneCommandStatus)) return false;
  if (expected && "leaseOwner" in expected && current.leaseOwner !== expected.leaseOwner) return false;
  if (
    expected &&
    "leaseExpiresAt" in expected &&
    current.leaseExpiresAt?.getTime() !== expected.leaseExpiresAt?.getTime()
  ) return false;
  if (expected && "attemptCount" in expected && current.attemptCount !== expected.attemptCount) return false;
  return true;
}

function conflict(
  input: { readonly commandId: string; readonly onConflict?: "throw" | "return-null" },
  message: string,
  details: Record<string, unknown>,
) {
  if (input.onConflict === "return-null") return null;
  throw Errors.conflict(message, details);
}

export function transitionControlPlaneCommand(
  tx: Prisma.TransactionClient,
  input: TransitionControlPlaneCommandInput & { readonly onConflict: "return-null" },
): Promise<ControlPlaneCommand | null>;
export function transitionControlPlaneCommand(
  tx: Prisma.TransactionClient,
  input: TransitionControlPlaneCommandInput & { readonly onConflict?: "throw" },
): Promise<ControlPlaneCommand>;
export async function transitionControlPlaneCommand(
  tx: Prisma.TransactionClient,
  input: TransitionControlPlaneCommandInput,
): Promise<ControlPlaneCommand | null> {
  const current = await tx.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!current) {
    return conflict(input, "Control-plane command does not exist", { commandId: input.commandId });
  }
  if (!matchesExpectation(current, input.expected)) {
    return conflict(input, "Control-plane command changed before transition", {
      commandId: input.commandId,
      status: current.status,
      leaseOwner: current.leaseOwner,
      attemptCount: current.attemptCount,
    });
  }
  if (!isControlPlaneCommandTransitionAllowed(current.status, input.to)) {
    return conflict(
      input,
      `Control-plane command transition ${current.status} -> ${input.to} is not allowed`,
      { commandId: input.commandId },
    );
  }

  const changed = await tx.controlPlaneCommand.updateMany({
    where: {
      id: current.id,
      status: current.status,
      leaseOwner: input.expected && "leaseOwner" in input.expected
        ? input.expected.leaseOwner
        : undefined,
      leaseExpiresAt: input.expected && "leaseExpiresAt" in input.expected
        ? input.expected.leaseExpiresAt
        : undefined,
      attemptCount: input.expected && "attemptCount" in input.expected
        ? input.expected.attemptCount
        : undefined,
    },
    data: { ...input.data, status: input.to },
  });
  if (changed.count !== 1) {
    return conflict(input, "Control-plane command changed during transition", {
      commandId: input.commandId,
      from: current.status,
      to: input.to,
    });
  }
  return tx.controlPlaneCommand.findUniqueOrThrow({ where: { id: current.id } });
}

export function updateControlPlaneCommandMetadata(
  tx: Prisma.TransactionClient,
  input: UpdateControlPlaneCommandMetadataInput & { readonly onConflict: "return-null" },
): Promise<ControlPlaneCommand | null>;
export function updateControlPlaneCommandMetadata(
  tx: Prisma.TransactionClient,
  input: UpdateControlPlaneCommandMetadataInput & { readonly onConflict?: "throw" },
): Promise<ControlPlaneCommand>;
export async function updateControlPlaneCommandMetadata(
  tx: Prisma.TransactionClient,
  input: UpdateControlPlaneCommandMetadataInput,
): Promise<ControlPlaneCommand | null> {
  const current = await tx.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!current) {
    return conflict(input, "Control-plane command does not exist", { commandId: input.commandId });
  }
  if (!matchesExpectation(current, input.expected)) {
    return conflict(input, "Control-plane command changed before metadata update", {
      commandId: input.commandId,
      status: current.status,
      leaseOwner: current.leaseOwner,
      attemptCount: current.attemptCount,
    });
  }
  const changed = await tx.controlPlaneCommand.updateMany({
    where: {
      id: current.id,
      status: current.status,
      leaseOwner: input.expected && "leaseOwner" in input.expected
        ? input.expected.leaseOwner
        : undefined,
      leaseExpiresAt: input.expected && "leaseExpiresAt" in input.expected
        ? input.expected.leaseExpiresAt
        : undefined,
      attemptCount: input.expected && "attemptCount" in input.expected
        ? input.expected.attemptCount
        : undefined,
    },
    data: input.data,
  });
  if (changed.count !== 1) {
    return conflict(input, "Control-plane command changed during metadata update", {
      commandId: input.commandId,
      status: current.status,
    });
  }
  return tx.controlPlaneCommand.findUniqueOrThrow({ where: { id: current.id } });
}
