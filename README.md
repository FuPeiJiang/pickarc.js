# pickarc

Pick files from local or remote ZIP archives after applying ordered path rules.

```sh
pickarc ls [options] <archive...>
pickarc du [options] <archive...>
pickarc stat [options] <archive...>
pickarc cat [options] <archive...>
pickarc cp [options] <archive...>
```

The package is TypeScript for Bun and runs directly from `src/cli.ts`; there is no build step and no `dist` output.

## Install

From a GitHub repo:

```sh
bun add -g github:FuPeiJiang/pickarc.js
```

Tarball fallback:

```sh
bun add -g https://github.com/FuPeiJiang/pickarc.js/archive/refs/heads/main.tar.gz
```

From a local checkout:

```sh
bun install
bun link
pickarc --help
```

## Status

Implemented:

- local `.zip` files
- HTTP(S) ZIP files through range requests
- `ls`, `du`, `stat`, `cat`, `cp`
- stored and deflated ZIP entries
- CRC32 checks by default
- ZipCrypto and WinZip AES encrypted ZIP entries
- nested stored ZIP expansion with `--as-dir`
- duplicate final-path detection before normal file reads
- proxy support through Bun `fetch`
- optional `-k, --insecure` TLS verification disable switch

Planned:

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

### Glob Examples

```sh
# All disk images.
pickarc ls --include-glob '**/*.img' archive.zip

# Include source files, but skip vendored paths.
pickarc ls \
  --include-glob 'src/**/*.ts' \
  --exclude-glob '**/vendor/**' \
  archive.zip

# Match either a sysroot tree or selected Clang trees.
pickarc ls \
  --include-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/sysroot/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/lib/linux/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/include/**' \
  archive.zip

# Treat matching stored ZIP entries as directories.
pickarc ls \
  --as-dir-keep-ext-glob '*/image-*.zip' \
  --include-glob '*/image-*.zip/*.img' \
  factory.zip
```

## Remote Archives

Remote archives use Bun `fetch` with HTTP range requests:

```sh
pickarc ls https://example.com/archive.zip
```

Use `--proxy <url>` to pass a proxy to Bun fetch.

`-k, --insecure` disables TLS certificate verification for HTTPS requests. This is dangerous and should only be used for testing or trusted networks:

```sh
pickarc ls --insecure https://self-signed.example/archive.zip
```

## Real Examples

Copy only the Android NDK LLVM sysroot and Clang runtime/include trees while removing the top archive directory:

```sh
pickarc cp \
  --include-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/sysroot/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/lib/linux/**' \
  --or-glob 'android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/include/**' \
  --strip-components 1 \
  https://dl.google.com/android/repository/android-ndk-r29-linux.zip
```

Extract `boot.img` and `init_boot.img` from the stored inner ZIP inside a Pixel factory image:

```sh
pickarc cp \
  --as-dir-keep-ext-glob '*/image-*.zip' \
  --include-glob '*/image-*.zip/boot.img' \
  --or-glob '*/image-*.zip/init_boot.img' \
  --flatten \
  https://dl.google.com/dl/android/aosp/husky-uq1a.240205.004-factory-594e3ca4.zip
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

`cp` writes files with exclusive create flags and `O_NOFOLLOW`, and refuses to overwrite existing files. Existing symlinked parent directories are rejected during directory creation/walk checks.

Permission handling is controlled by:

```sh
--permissions owner
--permissions preserve
--permissions sanitize
--permissions private
--preserve-special-mode sticky
--preserve-special-mode setgid
--preserve-special-mode setuid
--preserve-special-mode all
```

The default is `--permissions owner`: preserve only the archive owner permission bits, so `0755` becomes `0700` and `0644` becomes `0600`. `preserve` keeps normal `0o777` Unix mode bits, `sanitize` keeps normal mode bits but removes group/other write, and `private` forces files to `0600` and directories to `0700`.

Special mode bits are dropped unless explicitly requested with repeatable `--preserve-special-mode` flags. Symlinks and special file types are still refused.

Files and directories are created private first. File modes are applied after the file is written successfully; directory modes are applied after extraction, deepest directory first. On Windows, permission handling is best-effort because POSIX modes do not map cleanly to Windows ACLs.

For remote ZIPs, `cp` validates final paths first, then downloads files in physical archive order. It plans selected byte ranges from ZIP metadata, merges nearby compressed ranges into bounded reads, and serves per-file extraction from that cache instead of making thousands of tiny requests.

`cp` shows progress on `stderr` when running in an interactive terminal. Control it with:

```sh
--progress auto
--progress always
--progress never
--no-progress
--jobs 1
```

The progress display uses ASCII bars with color when the terminal allows it:

```text
libclang_rt.asan.so
    18.2 MiB / 53.6 MiB  [#######-------------]   34%  8.4 MiB/s
  total
    375 MiB / 612 MiB    [############--------]   61%  3,812/6,230
```

`NO_COLOR` disables color. `FORCE_COLOR=1` enables color when `--progress always` is used outside a TTY.

`--jobs <n>` controls file extraction concurrency. The default is `1`; higher values can help on some machines, but the Android NDK benchmark is faster sequentially after range grouping.

## Encrypted ZIPs

`cat` and `cp` can read traditional ZipCrypto entries and WinZip AES entries. Password rules match final paths after all path operations, so they work with `--replace`, `--strip-components`, and `--flatten`.

Prefer env vars or password files when possible:

```sh
pickarc cat --password-env ZIP_PASSWORD archive.zip

pickarc cp \
  --password-file-for-glob 'private/**' ./zip-password.txt \
  --include-glob 'private/**' \
  archive.zip
```

Literal passwords are also supported, but they can be visible in process lists and shell history:

```sh
pickarc cp --password-for-glob '*.txt' 'secret' archive.zip
```

Available password options:

- `--password <password>`
- `--password-file <path>`
- `--password-env <name>`
- `--password-for <regex> <password>`
- `--password-file-for <regex> <path>`
- `--password-env-for <regex> <name>`
- `--password-for-glob <glob> <password>`
- `--password-file-for-glob <glob> <path>`
- `--password-env-for-glob <glob> <name>`

Password files have one trailing line ending stripped.

PKWARE strong encryption is not supported.

## Metadata

`du` summarizes selected entries without reading file contents:

```sh
pickarc du --by dir --depth 1 archive.zip
pickarc du --json archive.zip
```

`du --by dir` reports recursive directory totals. By default it shows `.` and first-level directories; use `--depth <n>` or `--all` to control how many directory groups are printed. `--bytes` prints raw byte counts instead of human-readable sizes.

Example output:

```text
compressed  uncompressed  files  dirs  entries  path
197 MiB     688 MiB       5,959  271   6,230    .
84.3 MiB    302 MiB       2,140  94    2,234    toolchains
```

`stat` prints per-entry metadata:

```sh
pickarc stat archive.zip
pickarc stat --json archive.zip
pickarc stat --jsonl archive.zip
```

JSON metadata includes final path, source path, archive label, kind, compression method, raw compression method, encryption method, compressed and uncompressed size, CRC32, symlink status, and local header offset.

Example JSONL:

```json
{"path":"boot.img","sourcePath":"image.zip!boot.img","archive":"factory.zip!image.zip","kind":"file","compressionMethod":8,"rawCompressionMethod":8,"compressionName":"deflate","encrypted":false,"encryptionMethod":"none","compressedSize":67108864,"uncompressedSize":67108864,"crc32":"1234abcd","isSymlink":false,"localHeaderOffset":1024}
```

## Checksums

CRC32 is checked when reading file contents. `--ignore-checksum <regex>` skips the check only when the final path matches:

```sh
pickarc cp archive.zip --ignore-checksum '^legacy/bad.bin$'
```

WinZip AES AE-2 entries are authenticated with their AES HMAC instead of the ZIP CRC32 field, which is normally stored as zero.

## Nested ZIPs

`--as-dir` treats a matching ZIP entry as a directory. The entry must be stored with ZIP compression method `0`; compressed nested archives are refused.

```sh
pickarc ls outer.zip --as-dir '\\.zip$'
```

Without `--as-dir-keep-ext`, `nested.zip/file.txt` is listed as `nested/file.txt`.

Encrypted nested ZIP entries are refused for `--as-dir`. Supporting them without buffering the whole nested archive needs a seekable encrypted range source and authentication policy.

## License

pickarc is licensed under either Apache-2.0 or GPL-2.0-only, at your option.

## Development

```sh
bun install
bun test
bun run typecheck
```
