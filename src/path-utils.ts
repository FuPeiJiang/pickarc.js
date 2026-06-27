import { fail } from "./errors.ts";

const windowsDrivePrefix = /^[A-Za-z]:/;
const windowsAbsolutePath = /^[A-Za-z]:(?:\/|$)/;

export function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith("/") || windowsAbsolutePath.test(path);
}

export function hasWindowsDrivePrefix(path: string): boolean {
  return windowsDrivePrefix.test(path);
}

export function normalizeVirtualPath(path: string, context: string): string {
  let value = path.replaceAll("\\", "/");
  let prefix = "";

  if (windowsDrivePrefix.test(value)) {
    prefix = value.slice(0, 2);
    value = value.slice(2);
  }

  if (value.startsWith("/")) {
    value = value.replace(/^\/+/, "/");
    prefix = prefix === "" ? "/" : `${prefix}/`;
    value = value.slice(1);
  }

  const parts: string[] = [];

  for (const part of value.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      fail(`${context}: refused path with '..' component`);
    }

    parts.push(part);
  }

  if (prefix === "/") {
    return parts.length === 0 ? "/" : `/${parts.join("/")}`;
  }

  if (prefix.endsWith("/")) {
    return parts.length === 0 ? prefix : `${prefix}${parts.join("/")}`;
  }

  return parts.length === 0 ? prefix : `${prefix}${parts.join("/")}`;
}

export function normalizeArchivePath(path: string, archiveLabel: string): string {
  if (hasWindowsDrivePrefix(path.replaceAll("\\", "/"))) {
    fail(`${archiveLabel}: refused archive path with Windows drive prefix: ${path}`);
  }

  const normalized = normalizeVirtualPath(path, archiveLabel);

  if (normalized === "" || normalized === "." || normalized === "/") {
    fail(`${archiveLabel}: refused empty archive path`);
  }

  if (isAbsoluteLikePath(normalized)) {
    fail(`${archiveLabel}: refused absolute archive path: ${path}`);
  }

  return normalized;
}

export function assertUsableFinalPath(path: string, absoluteFromReplace: boolean): void {
  if (path === "" || path === "." || path === "/" || /^[A-Za-z]:\/?$/.test(path)) {
    fail(`refused empty final path`);
  }

  if (isAbsoluteLikePath(path) && !absoluteFromReplace) {
    fail(`refused absolute final path not produced by --replace: ${path}`);
  }
}

export function basenameOfVirtualPath(path: string): string {
  const normalized = normalizeVirtualPath(path, "path");
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  const slash = withoutTrailingSlash.lastIndexOf("/");
  return slash === -1 ? withoutTrailingSlash : withoutTrailingSlash.slice(slash + 1);
}

export function stripLeadingComponents(path: string, count: number): string | undefined {
  const normalized = normalizeVirtualPath(path, "path");
  const absolute = isAbsoluteLikePath(normalized);
  const components = normalized
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean);

  if (components.length <= count) {
    return undefined;
  }

  const stripped = components.slice(count).join("/");
  return absolute && /^[A-Za-z]:\//.test(normalized)
    ? normalizeVirtualPath(stripped, "path")
    : normalizeVirtualPath(stripped, "path");
}

export function stripLastExtension(path: string): string {
  const normalized = normalizeVirtualPath(path, "path");
  const slash = normalized.lastIndexOf("/");
  const directory = slash === -1 ? "" : normalized.slice(0, slash + 1);
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = basename.lastIndexOf(".");

  if (dot <= 0) {
    return normalized;
  }

  return `${directory}${basename.slice(0, dot)}`;
}

export function joinVirtualPath(prefix: string, child: string): string {
  if (prefix === "" || prefix === ".") {
    return normalizeVirtualPath(child, "path");
  }

  return normalizeVirtualPath(`${prefix.replace(/\/+$/, "")}/${child}`, "path");
}
