import { fail } from "./errors.ts";

export type PermissionsMode = "preserve" | "sanitize" | "owner" | "private";
export type SpecialModeName = "setuid" | "setgid" | "sticky" | "all";

export interface PermissionPolicy {
  permissions: PermissionsMode;
  specialModeBits: number;
}

export interface ModeCandidate {
  kind: "file" | "directory";
  unixMode: number | undefined;
}

export const fallbackFileMode = 0o644;
export const fallbackDirectoryMode = 0o755;
export const privateFileMode = 0o600;
export const privateDirectoryMode = 0o700;

const normalModeMask = 0o777;
const specialModeMask = 0o7000;
const groupOtherWriteMask = 0o022;

export function modeForCandidate(candidate: ModeCandidate, policy: PermissionPolicy): number {
  const normalMode = normalPermissions(candidate);
  let finalNormalMode: number;

  switch (policy.permissions) {
    case "preserve":
      finalNormalMode = normalMode;
      break;

    case "sanitize":
      finalNormalMode = normalMode & ~groupOtherWriteMask;
      break;

    case "owner":
      finalNormalMode = normalMode & 0o700;
      break;

    case "private":
      finalNormalMode = candidate.kind === "directory" ? privateDirectoryMode : privateFileMode;
      break;
  }

  return (finalNormalMode | specialPermissions(candidate, policy.specialModeBits)) & 0o7777;
}

export function parsePermissionsMode(value: string): PermissionsMode {
  if (
    value === "preserve" ||
    value === "sanitize" ||
    value === "owner" ||
    value === "private"
  ) {
    return value;
  }

  fail(`--permissions: expected preserve, sanitize, owner, or private`);
}

export function parseSpecialModeName(value: string): SpecialModeName {
  if (
    value === "setuid" ||
    value === "setgid" ||
    value === "sticky" ||
    value === "all"
  ) {
    return value;
  }

  fail(`--preserve-special-mode: expected setuid, setgid, sticky, or all`);
}

export function specialModeMaskFor(name: SpecialModeName): number {
  switch (name) {
    case "setuid":
      return 0o4000;

    case "setgid":
      return 0o2000;

    case "sticky":
      return 0o1000;

    case "all":
      return specialModeMask;
  }
}

function normalPermissions(candidate: ModeCandidate): number {
  if (candidate.unixMode !== undefined) {
    return candidate.unixMode & normalModeMask;
  }

  return candidate.kind === "directory" ? fallbackDirectoryMode : fallbackFileMode;
}

function specialPermissions(candidate: ModeCandidate, allowedMask: number): number {
  if (candidate.unixMode === undefined) {
    return 0;
  }

  return candidate.unixMode & specialModeMask & allowedMask;
}
