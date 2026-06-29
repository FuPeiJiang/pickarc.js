import { constants } from "node:fs";
import { lstat, mkdir, open, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { fail } from "./errors.ts";
import type { DeviceNumbers } from "./zip.ts";

const windowsAbsolutePath = /^[A-Za-z]:\//;
const initialFileMode = 0o600;
const initialDirectoryMode = 0o700;
let nativeFchmod: ((fd: number, mode: number) => number) | undefined;
// Keep the dlopen handle alive for the cached native symbol.
let nativeFchmodLibrary: unknown;
let nativeSpecial: NativeSpecialSymbols | undefined;
// Keep the dlopen handle alive for the cached native symbols.
let nativeSpecialLibrary: unknown;

export interface ResolvedOutputPath {
  target: string;
}

export interface EnsuredDirectory {
  target: string;
  created: boolean;
}

interface NativeSpecialSymbols {
  mkfifo: (path: number, mode: number) => number;
  mknod: (path: number, mode: number, device: number | bigint) => number;
  socket: (domain: number, type: number, protocol: number) => number;
  bind: (socket: number, address: number, length: number) => number;
  close: (fd: number) => number;
  chmod: (path: number, mode: number) => number;
}

interface DirectoryNode {
  segment: string;
  target: string;
  depth: number;
  children: DirectoryNode[];
  childMap: Map<string, DirectoryNode> | undefined;
  pending: Promise<void> | undefined;
  ready: boolean;
  createdByUs: boolean;
  explicitMode: number | undefined;
}

const childMapThreshold = 16;

export class DirectoryEnsurer {
  private readonly lockdownRoot: string | undefined;
  private readonly roots: DirectoryNode[] = [];
  private rootMap: Map<string, DirectoryNode> | undefined = undefined;
  private readonly createdBuckets: DirectoryNode[][] = [];

  private constructor(lockdownRoot: string | undefined) {
    this.lockdownRoot = lockdownRoot;
  }

  static async create(lockdown: string | undefined): Promise<DirectoryEnsurer> {
    return new DirectoryEnsurer(
      lockdown === undefined ? undefined : await resolveLockdownRoot(lockdown),
    );
  }

  resolve(finalPath: string): ResolvedOutputPath {
    if (windowsAbsolutePath.test(finalPath) && process.platform !== "win32") {
      fail(`${finalPath}: Windows absolute output paths are not writable on this platform`);
    }

    const target = path.isAbsolute(finalPath)
      ? path.resolve(finalPath)
      : path.resolve(process.cwd(), finalPath);

    if (this.lockdownRoot !== undefined && !isWithin(this.lockdownRoot, target)) {
      fail(`${finalPath}: output path escapes lockdown root ${this.lockdownRoot}`);
    }

    return {
      target,
    };
  }

  async ensureParent(target: string): Promise<void> {
    await this.ensureDirectory(path.dirname(target));
  }

  async ensureFinalDirectory(finalPath: string): Promise<EnsuredDirectory> {
    const { target } = this.resolve(finalPath);
    const node = await this.ensureDirectory(target);

    return {
      target,
      created: node?.createdByUs === true,
    };
  }

  noteExplicitDirectoryMode(target: string, mode: number, fallbackMode: number): void {
    if (mode === fallbackMode) {
      return;
    }

    const node = this.findNode(target);

    if (node?.createdByUs === true) {
      node.explicitMode = mode;
    }
  }

  async applyCreatedDirectoryModes(fallbackMode: number): Promise<void> {
    for (let depth = this.createdBuckets.length - 1; depth >= 0; depth -= 1) {
      const bucket = this.createdBuckets[depth];

      if (bucket === undefined) {
        continue;
      }

      for (let index = 0; index < bucket.length; index += 1) {
        const node = bucket[index]!;
        await chmodCreatedDirectory(node.target, node.explicitMode ?? fallbackMode);
      }
    }
  }

  private async ensureDirectory(directory: string): Promise<DirectoryNode | undefined> {
    if (this.lockdownRoot !== undefined && !isWithin(this.lockdownRoot, directory)) {
      fail(`${directory}: directory escapes lockdown root ${this.lockdownRoot}`);
    }

    const root = path.parse(directory).root;
    const relative = path.relative(root, directory);

    if (relative === "") {
      return undefined;
    }

    let parent = this.rootNode(root);
    let current = root;
    const parts = relative.split(path.sep);

    for (let index = 0; index < parts.length; index += 1) {
      const segment = parts[index]!;

      if (segment === "") {
        continue;
      }

      current = path.join(current, segment);
      parent = childNode(parent, segment, current, index + 1);
      await this.ensureNode(parent);
    }

    return parent;
  }

  private async ensureNode(node: DirectoryNode): Promise<void> {
    if (node.ready) {
      return;
    }

    if (node.pending !== undefined) {
      await node.pending;
      return;
    }

    node.pending = this.mkdirOrValidate(node);
    await node.pending;
  }

  private async mkdirOrValidate(node: DirectoryNode): Promise<void> {
    try {
      await mkdir(node.target, { mode: initialDirectoryMode });
      node.createdByUs = true;
      node.ready = true;
      this.rememberCreatedNode(node);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }

    const info = await lstat(node.target);

    if (info.isSymbolicLink()) {
      fail(`${node.target}: refused symlinked parent directory`);
    }

    if (!info.isDirectory()) {
      fail(`${node.target}: expected a directory`);
    }

    node.createdByUs = false;
    node.ready = true;
  }

  private rememberCreatedNode(node: DirectoryNode): void {
    let bucket = this.createdBuckets[node.depth];

    if (bucket === undefined) {
      bucket = [];
      this.createdBuckets[node.depth] = bucket;
    }

    bucket.push(node);
  }

  private rootNode(root: string): DirectoryNode {
    const existing = lookupNode(this.roots, this.rootMap, root);

    if (existing !== undefined) {
      return existing;
    }

    const node = newDirectoryNode(root, root, 0);
    node.ready = true;
    this.roots.push(node);

    if (this.rootMap !== undefined) {
      this.rootMap.set(root, node);
    } else if (this.roots.length >= childMapThreshold) {
      this.rootMap = nodesBySegment(this.roots);
    }

    return node;
  }

  private findNode(target: string): DirectoryNode | undefined {
    const root = path.parse(target).root;
    const rootNode = lookupNode(this.roots, this.rootMap, root);

    if (rootNode === undefined) {
      return undefined;
    }

    const relative = path.relative(root, target);

    if (relative === "") {
      return undefined;
    }

    let node = rootNode;
    const parts = relative.split(path.sep);

    for (let index = 0; index < parts.length; index += 1) {
      const segment = parts[index]!;

      if (segment === "") {
        continue;
      }

      const child = lookupNode(node.children, node.childMap, segment);

      if (child === undefined) {
        return undefined;
      }

      node = child;
    }

    return node;
  }
}

export async function writeFileExclusive(
  finalPath: string,
  data: Uint8Array,
  output: DirectoryEnsurer,
  mode: number,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  await output.ensureParent(target);

  let handle;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      initialFileMode,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    await handle.writeFile(data);
    await chmodOpenHandle(handle, mode);
  } finally {
    await handle.close();
  }
}

export async function writeFileExclusiveStream(
  finalPath: string,
  chunks: AsyncIterable<Uint8Array>,
  output: DirectoryEnsurer,
  mode: number,
  onChunk?: (bytes: number) => void,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  await output.ensureParent(target);

  let handle;
  let completed = false;

  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      initialFileMode,
    );
  } catch (error) {
    failOpen(target, error);
  }

  try {
    for await (const chunk of chunks) {
      await writeAll(handle, chunk);
      onChunk?.(chunk.byteLength);
    }

    await chmodOpenHandle(handle, mode);
    completed = true;
  } finally {
    await handle.close();

    if (!completed) {
      await unlink(target).catch(() => undefined);
    }
  }
}

export async function createSymlinkExclusive(
  finalPath: string,
  targetBytes: Uint8Array,
  output: DirectoryEnsurer,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  assertPosixSpecialFileSupport(target, "symlink");
  await output.ensureParent(target);
  const linkTarget = decodeSymlinkTarget(target, targetBytes);

  try {
    await symlink(linkTarget, target);
  } catch (error) {
    failOpen(target, error);
  }
}

export async function createFifoExclusive(
  finalPath: string,
  output: DirectoryEnsurer,
  mode: number,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  assertPosixSpecialFileSupport(target, "FIFO");
  await output.ensureParent(target);
  await assertMissingTarget(target);
  const pathBytes = cPath(target);
  const result = specialNativeSymbols().mkfifo(ptr(pathBytes), initialFileMode);

  if (result !== 0) {
    failNativeSpecial(target, "mkfifo", result);
  }

  await assertSpecialPathType(target, "FIFO", (info) => info.isFIFO());
  await chmodSpecialPath(target, mode);
}

export async function createDeviceExclusive(
  finalPath: string,
  output: DirectoryEnsurer,
  mode: number,
  deviceType: "char-device" | "block-device",
  deviceNumbers: DeviceNumbers,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  assertPosixSpecialFileSupport(target, deviceType);
  await output.ensureParent(target);
  await assertMissingTarget(target);
  const pathBytes = cPath(target);
  const fileTypeMode = deviceType === "char-device" ? 0o020000 : 0o060000;
  const result = specialNativeSymbols().mknod(
    ptr(pathBytes),
    fileTypeMode | initialFileMode,
    encodeDeviceNumber(deviceNumbers, target),
  );

  if (result !== 0) {
    failNativeSpecial(target, "mknod", result, "; root or CAP_MKNOD may be required");
  }

  await assertSpecialPathType(
    target,
    deviceType,
    deviceType === "char-device"
      ? (info) => info.isCharacterDevice()
      : (info) => info.isBlockDevice(),
  );
  await chmodSpecialPath(target, mode);
}

export async function createSocketExclusive(
  finalPath: string,
  output: DirectoryEnsurer,
  mode: number,
): Promise<void> {
  const { target } = output.resolve(finalPath);
  assertPosixSpecialFileSupport(target, "socket");
  await output.ensureParent(target);
  await assertMissingTarget(target);
  const native = specialNativeSymbols();
  const fd = native.socket(1, 1, 0);

  if (fd < 0) {
    failNativeSpecial(target, "socket", fd);
  }

  let completed = false;

  try {
    const address = unixSocketAddress(target);
    const result = native.bind(fd, ptr(address.bytes), address.length);

    if (result !== 0) {
      failNativeSpecial(target, "bind", result);
    }

    completed = true;
  } finally {
    native.close(fd);

    if (!completed) {
      await unlink(target).catch(() => undefined);
    }
  }

  await assertSpecialPathType(target, "socket", (info) => info.isSocket());
  await chmodSpecialPath(target, mode);
}

export async function chmodCreatedDirectory(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const info = await lstat(target);

  if (info.isSymbolicLink()) {
    fail(`${target}: refused symlinked directory during chmod`);
  }

  if (!info.isDirectory()) {
    fail(`${target}: expected a directory during chmod`);
  }

  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle;

  try {
    handle = await open(target, flags);
  } catch (error) {
    failOpen(target, error);
  }

  try {
    await chmodOpenHandle(handle, mode);
  } finally {
    await handle.close();
  }
}

async function resolveLockdownRoot(lockdown: string): Promise<string> {
  const root = path.resolve(lockdown);
  let info;

  try {
    info = await lstat(root);
  } catch (error) {
    failOpen(root, error);
  }

  if (info.isSymbolicLink()) {
    fail(`${root}: lockdown root must not be a symlink`);
  }

  if (!info.isDirectory()) {
    fail(`${root}: lockdown root must be a directory`);
  }

  return root;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function newDirectoryNode(segment: string, target: string, depth: number): DirectoryNode {
  return {
    segment,
    target,
    depth,
    children: [],
    childMap: undefined,
    pending: undefined,
    ready: false,
    createdByUs: false,
    explicitMode: undefined,
  };
}

function childNode(
  parent: DirectoryNode,
  segment: string,
  target: string,
  depth: number,
): DirectoryNode {
  const existing = lookupNode(parent.children, parent.childMap, segment);

  if (existing !== undefined) {
    return existing;
  }

  const node = newDirectoryNode(segment, target, depth);
  parent.children.push(node);

  if (parent.childMap !== undefined) {
    parent.childMap.set(segment, node);
  } else if (parent.children.length >= childMapThreshold) {
    parent.childMap = nodesBySegment(parent.children);
  }

  return node;
}

function lookupNode(
  nodes: readonly DirectoryNode[],
  nodeMap: Map<string, DirectoryNode> | undefined,
  segment: string,
): DirectoryNode | undefined {
  if (nodeMap !== undefined) {
    return nodeMap.get(segment);
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;

    if (node.segment === segment) {
      return node;
    }
  }

  return undefined;
}

function nodesBySegment(nodes: readonly DirectoryNode[]): Map<string, DirectoryNode> {
  const nodeMap = new Map<string, DirectoryNode>();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    nodeMap.set(node.segment, node);
  }

  return nodeMap;
}

function failOpen(target: string, error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

  if (code === "EEXIST") {
    fail(`${target}: refused to overwrite existing path`);
  }

  if (code === "ELOOP") {
    fail(`${target}: refused symlink output path`);
  }

  if (code === "ENOENT") {
    fail(`${target}: path does not exist`);
  }

  fail(`${target}: ${String(error)}`);
}

async function assertMissingTarget(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }

    failOpen(target, error);
  }

  fail(`${target}: refused to overwrite existing path`);
}

function assertPosixSpecialFileSupport(target: string, kind: string): void {
  if (process.platform === "win32") {
    fail(`${target}: ${kind} extraction is not supported on Windows`);
  }
}

function decodeSymlinkTarget(target: string, bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);

  if (text.includes("\0")) {
    fail(`${target}: symlink target contains a NUL byte`);
  }

  if (text.length === 0) {
    fail(`${target}: symlink target is empty`);
  }

  return text;
}

async function assertSpecialPathType(
  target: string,
  expected: string,
  predicate: (info: Awaited<ReturnType<typeof lstat>>) => boolean,
): Promise<void> {
  const info = await lstat(target);

  if (!predicate(info)) {
    fail(`${target}: expected created ${expected}`);
  }
}

async function chmodSpecialPath(target: string, mode: number): Promise<void> {
  const pathBytes = cPath(target);
  const result = specialNativeSymbols().chmod(ptr(pathBytes), mode);

  if (result !== 0) {
    failNativeSpecial(target, "chmod", result);
  }
}

function cPath(target: string): Uint8Array {
  if (target.includes("\0")) {
    fail(`${target}: path contains a NUL byte`);
  }

  return Buffer.from(`${target}\0`, "utf8");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += result.bytesWritten;
  }
}

async function chmodOpenHandle(
  handle: Awaited<ReturnType<typeof open>>,
  mode: number,
): Promise<void> {
  if ((mode & 0o7000) === 0 || process.platform === "win32") {
    await handle.chmod(mode);
    return;
  }

  if (fchmodLibraryCandidates().length === 0) {
    await handle.chmod(mode);
    return;
  }

  const result = fchmod()(handle.fd, mode);

  if (result !== 0) {
    fail(`fchmod ${mode.toString(8)} failed with code ${result}`);
  }
}

function fchmod(): (fd: number, mode: number) => number {
  if (nativeFchmod !== undefined) {
    return nativeFchmod;
  }

  const candidates = fchmodLibraryCandidates();
  const errors: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    try {
      const library = dlopen(candidate, {
        fchmod: {
          args: [FFIType.i32, FFIType.u32],
          returns: FFIType.i32,
        },
      });

      nativeFchmodLibrary = library;
      nativeFchmod = library.symbols.fchmod as (fd: number, mode: number) => number;
      return nativeFchmod;
    } catch (error) {
      errors.push(`${candidate}: ${String(error)}`);
    }
  }

  fail(`failed to load native fchmod: ${errors.join("; ")}`);
}

function specialNativeSymbols(): NativeSpecialSymbols {
  if (nativeSpecial !== undefined) {
    return nativeSpecial;
  }

  const candidates = fchmodLibraryCandidates();
  const errors: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    try {
      const library = dlopen(candidate, {
        mkfifo: {
          args: [FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        mknod: {
          args: [
            FFIType.ptr,
            FFIType.u32,
            process.platform === "darwin" ? FFIType.u32 : FFIType.u64,
          ],
          returns: FFIType.i32,
        },
        socket: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        bind: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        close: {
          args: [FFIType.i32],
          returns: FFIType.i32,
        },
        chmod: {
          args: [FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
      });

      nativeSpecialLibrary = library;
      nativeSpecial = library.symbols as NativeSpecialSymbols;
      return nativeSpecial;
    } catch (error) {
      errors.push(`${candidate}: ${String(error)}`);
    }
  }

  fail(`failed to load native special-file functions: ${errors.join("; ")}`);
}

function encodeDeviceNumber(device: DeviceNumbers, target: string): number | bigint {
  assertUint32(device.major, target, "major");
  assertUint32(device.minor, target, "minor");

  if (process.platform === "darwin") {
    if (device.major > 0xff || device.minor > 0xffffff) {
      fail(`${target}: device number is too large for this platform`);
    }

    return ((device.major & 0xff) << 24) | (device.minor & 0xffffff);
  }

  const major = BigInt(device.major);
  const minor = BigInt(device.minor);
  return (
    (minor & 0xffn) |
    ((major & 0xfffn) << 8n) |
    ((minor & ~0xffn) << 12n) |
    ((major & ~0xfffn) << 32n)
  );
}

function assertUint32(value: number, target: string, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`${target}: invalid ${name} device number ${value}`);
  }
}

function unixSocketAddress(target: string): { bytes: Uint8Array; length: number } {
  if (process.platform === "darwin") {
    const pathBytes = Buffer.from(target, "utf8");
    const maxPathLength = 104;
    const length = 2 + pathBytes.byteLength;

    if (pathBytes.byteLength > maxPathLength || length > 0xff) {
      fail(`${target}: Unix socket path is too long`);
    }

    const bytes = new Uint8Array(2 + maxPathLength);
    bytes[0] = length;
    bytes[1] = 1;
    bytes.set(pathBytes, 2);
    return { bytes, length };
  }

  const pathBytes = Buffer.from(`${target}\0`, "utf8");
  const maxPathLength = 108;

  if (pathBytes.byteLength > maxPathLength) {
    fail(`${target}: Unix socket path is too long`);
  }

  const bytes = new Uint8Array(2 + maxPathLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(0, 1, true);
  bytes.set(pathBytes, 2);
  return {
    bytes,
    length: 2 + pathBytes.byteLength,
  };
}

function failNativeSpecial(
  target: string,
  operation: string,
  result: number,
  hint = "",
): never {
  fail(`${target}: ${operation} failed with code ${result}${hint}`);
}

export function fchmodLibraryCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string[] {
  switch (platform) {
    case "darwin":
      return ["libSystem.B.dylib", "libSystem.dylib"];

    case "linux": {
      const candidates = ["libc.so.6"];
      const muslLoader = muslLoaderName(arch);

      if (muslLoader !== undefined) {
        candidates.push(muslLoader);
      }

      candidates.push("libc.so");
      return candidates;
    }

    default:
      return [];
  }
}

function muslLoaderName(arch: NodeJS.Architecture): string | undefined {
  switch (arch) {
    case "x64":
      return "ld-musl-x86_64.so.1";

    case "arm64":
      return "ld-musl-aarch64.so.1";

    default:
      return undefined;
  }
}
