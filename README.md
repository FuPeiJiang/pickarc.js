# pickarc

Pick files from local or remote ZIP archives after applying ordered path rules.

```sh
pickarc ls [options] <archive...>
pickarc cat [options] <archive...>
pickarc cp [options] <archive...>
```

The package is TypeScript for Bun and runs directly from `src/cli.ts`; there is no build step and no `dist` output.

## Status

Implemented:

- local `.zip` files
- HTTP(S) ZIP files through range requests
- `ls`, `cat`, `cp`
- stored and deflated ZIP entries
- CRC32 checks by default
- nested stored ZIP expansion with `--as-dir`
- duplicate final-path detection before normal file reads

Planned:

- explicit QUIC transport preference when the runtime exposes a stable control
- `.rar` and `.7z`
- `tar`
- `mount`

## Path Rules

Archives are opened first and their entry lists are collected before file contents are copied or printed. Path operations run in the exact order they appear on the command line.

```sh
pickarc ls archive.zip \
  --include '^src/' \
  --replace '^src/(.*)$' 'vendor/$1' \
  --exclude '/test/'
```

Supported operations:

- `--include <regex>`, `--match <regex>`, `--matches <regex>`
- `--include-glob <glob>`, `--match-glob <glob>`, `--matches-glob <glob>`
- `--or <regex>`, `--or-glob <glob>`
- `--exclude <regex>`
- `--exclude-glob <glob>`
- `--replace <regex> <replacement>`
- `--strip-components <n>`, `--cut-prefix <n>`
- `--flatten`
- `--as-dir <regex>`, `--archive-is-dir <regex>`
- `--as-dir-glob <glob>`, `--archive-is-dir-glob <glob>`
- `--as-dir-keep-ext <regex>`, `--archive-is-dir-keep-ext <regex>`
- `--as-dir-keep-ext-glob <glob>`, `--archive-is-dir-keep-ext-glob <glob>`

Regexes use JavaScript `RegExp` syntax. Replacements use JavaScript replacement strings, including `$1` and named groups.

Globs use `Bun.Glob` and match normalized archive paths directly. `--include`, `--match`, `--matches`, `--include-glob`, `--match-glob`, and `--matches-glob` start a new include group. `--or` and `--or-glob` add alternatives to the immediately previous include group. Multiple include groups compose in command order, so they behave like ordered filters.

Paths always use `/`. Rewrites normalize repeated slashes and `.` components. Any `..` component is refused.

Example, copy only the Android NDK LLVM sysroot and Clang runtime/include trees while removing the top archive directory:

```sh
pickarc cp \
  --include-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/sysroot/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/lib/linux/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/include/**' \
  --strip-components 1 \
  https://dl.google.com/android/repository/android-ndk-r29-linux.zip
```

## Copying

`cp` has no output directory argument. It writes each final path as produced by the path rules:

```sh
pickarc cp archive.zip \
  --include '^src/' \
  --replace '^src/(.*)$' 'out/$1'
```

Relative final paths are written relative to the current working directory. Absolute final paths are allowed only if `--replace` produced them:

```sh
pickarc cp archive.zip --replace '^file.txt$' '/tmp/file.txt'
```

Use `--lockdown <path>` to require every output path to stay inside a resolved directory:

```sh
pickarc cp archive.zip \
  --lockdown ./out \
  --replace '^src/(.*)$' './out/$1'
```

`cp` writes files with exclusive create flags and `O_NOFOLLOW`, mode `0600`, and refuses to overwrite existing files. Existing symlinked parent directories are rejected during directory creation/walk checks.

## Checksums

CRC32 is checked when reading file contents. `--ignore-checksum <regex>` skips the check only when the final path matches:

```sh
pickarc cp archive.zip --ignore-checksum '^legacy/bad.bin$'
```

## Nested ZIPs

`--as-dir` treats a matching ZIP entry as a directory. The entry must be stored with ZIP compression method `0`; compressed nested archives are refused.

```sh
pickarc ls outer.zip --as-dir '\\.zip$'
```

Without `--as-dir-keep-ext`, `nested.zip/file.txt` is listed as `nested/file.txt`.

## Development

```sh
bun install
bun test
bun run typecheck
```
