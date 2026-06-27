import { describe, expect, test } from "bun:test";
import { CopyProgress, formatBytes, renderPlanningFrame, renderProgressFrame } from "../src/progress.ts";

describe("progress rendering", () => {
  test("renders the selected ASCII bar layout without color", () => {
    const frame = renderProgressFrame(
      {
        filePath: "libclang_rt.asan.so",
        fileBytesDone: 18.2 * 1024 * 1024,
        fileBytesTotal: 53.6 * 1024 * 1024,
        totalBytesDone: 375 * 1024 * 1024,
        totalBytesTotal: 612 * 1024 * 1024,
        filesDone: 3812,
        filesTotal: 6230,
        bytesPerSecond: 8.4 * 1024 * 1024,
      },
      {
        color: false,
        columns: 80,
      },
    );

    expect(frame).toContain("libclang_rt.asan.so");
    expect(frame).toContain("18.2 MiB / 53.6 MiB");
    expect(frame).toContain("[#######-------------]");
    expect(frame).toContain("8.4 MiB/s");
    expect(frame).toContain("  total");
    expect(frame).toContain("375 MiB / 612 MiB");
    expect(frame).toContain("[############--------]");
    expect(frame).toContain("3,812/6,230");
  });

  test("renders bold labels and cyan bar when color is enabled", () => {
    const frame = renderProgressFrame(
      {
        filePath: "file.bin",
        fileBytesDone: 50,
        fileBytesTotal: 100,
        totalBytesDone: 50,
        totalBytesTotal: 100,
        filesDone: 0,
        filesTotal: 1,
        bytesPerSecond: 10,
      },
      {
        color: true,
        columns: 80,
      },
    );

    expect(frame).toContain("\x1b[1mfile.bin\x1b[0m");
    expect(frame).toContain("\x1b[36m##########");
    expect(frame).toContain("\x1b[2m----------]");
  });

  test("formats byte counts compactly", () => {
    expect(formatBytes(375 * 1024 * 1024)).toBe("375 MiB");
    expect(formatBytes(18.2 * 1024 * 1024)).toBe("18.2 MiB");
    expect(formatBytes(900)).toBe("900 B");
  });

  test("renders planning progress with current path", () => {
    const frame = renderPlanningFrame(
      {
        label: "resolving zip ranges",
        path: "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/linux/a.out.h",
        filesDone: 3912,
        filesTotal: 5959,
      },
      {
        color: false,
        columns: 80,
      },
    );

    expect(frame).toContain("plan");
    expect(frame).toContain("3,912 / 5,959 files");
    expect(frame).toContain("resolving zip ranges");
    expect(frame).toContain("current");
    expect(frame).toContain("linux/a.out.h");
  });

  test("emits planning frames in forced progress mode", () => {
    const writes: string[] = [];
    const progress = new CopyProgress({
      mode: "always",
      stream: {
        isTTY: false,
        columns: 80,
        write(data) {
          writes.push(data);
          return true;
        },
      },
      now: () => 1000,
    });

    progress.startPlanning({
      label: "resolving zip ranges",
      filesTotal: 2,
    });
    progress.advancePlanning({
      path: "a.txt",
      filesDone: 1,
    });
    progress.finishPlanning();

    expect(writes.join("")).toContain("resolving zip ranges");
    expect(writes.join("")).toContain("a.txt");
  });

  test("auto mode is disabled for non-tty streams", () => {
    const writes: string[] = [];
    const progress = new CopyProgress({
      mode: "auto",
      stream: {
        isTTY: false,
        write(data) {
          writes.push(data);
          return true;
        },
      },
      now: () => 0,
    });

    progress.start({ filesTotal: 1, bytesTotal: 100 });
    progress.startFile({ path: "file.bin", bytesTotal: 100 });
    progress.advanceFile(100);
    progress.finishFile();
    progress.finish();

    expect(writes).toEqual([]);
  });

  test("always mode can force colored progress through FORCE_COLOR", () => {
    const writes: string[] = [];
    const progress = new CopyProgress({
      mode: "always",
      stream: {
        isTTY: false,
        columns: 80,
        write(data) {
          writes.push(data);
          return true;
        },
      },
      env: {
        FORCE_COLOR: "1",
      },
      now: () => 1000,
    });

    progress.start({ filesTotal: 1, bytesTotal: 100 });
    progress.startFile({ path: "file.bin", bytesTotal: 100 });
    progress.advanceFile(50);
    progress.finishFile();
    progress.finish();

    expect(writes.join("")).toContain("\x1b[1mfile.bin\x1b[0m");
    expect(writes.join("")).toContain("\x1b[36m");
  });
});
