import { fail } from "./errors.ts";

export type PermissionsMode = "preserve" | "sanitize" | "owner" | "private";
export type SpecialModeName = "setuid" | "setgid" | "sticky" | "all";
export type SpecialFileType =
  | "symlink"
  | "fifo"
  | "char-device"
  | "block-device"
  | "socket";
export type ArchiveFileType = "none" | SpecialFileType | "unknown";
export type SpecialFileTypeName = SpecialFileType | "all";

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
const symlinkMask = 1 << 0;
const fifoMask = 1 << 1;
const charDeviceMask = 1 << 2;
const blockDeviceMask = 1 << 3;
const socketMask = 1 << 4;
const allSpecialFileTypesMask =
  symlinkMask | fifoMask | charDeviceMask | blockDeviceMask | socketMask;

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

export function parseSpecialFileTypeName(value: string): SpecialFileTypeName {
  if (
    value === "symlink" ||
    value === "fifo" ||
    value === "char-device" ||
    value === "block-device" ||
    value === "socket" ||
    value === "all"
  ) {
    return value;
  }

  fail(
    `--allow-special-file-types: expected symlink, fifo, char-device, block-device, socket, or all`,
  );
}

export function specialFileTypeMaskFor(name: SpecialFileTypeName): number {
  switch (name) {
    case "symlink":
      return symlinkMask;

    case "fifo":
      return fifoMask;

    case "char-device":
      return charDeviceMask;

    case "block-device":
      return blockDeviceMask;

    case "socket":
      return socketMask;

    case "all":
      return allSpecialFileTypesMask;
  }
}

export function isSpecialFileTypeAllowed(
  type: ArchiveFileType,
  allowedMask: number,
): boolean {
  if (type === "none" || type === "unknown") {
    return false;
  }

  return (specialFileTypeMaskFor(type) & allowedMask) !== 0;
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
