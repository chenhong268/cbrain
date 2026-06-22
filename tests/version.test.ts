import { describe, test, expect } from "bun:test";
import { readPackageVersion, FALLBACK_VERSION } from "../src/version";

describe("readPackageVersion", () => {
  test("正常解析有效 version 字段", () => {
    const read = () => JSON.stringify({ version: "9.9.9" });
    expect(readPackageVersion(read)).toBe("9.9.9");
  });

  test("compiled binary (ENOENT) 回退 fallback 不抛", () => {
    const read = () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    };
    expect(readPackageVersion(read)).toBe(FALLBACK_VERSION);
  });

  test("malformed JSON 回退 fallback", () => {
    const read = () => "{bad json";
    expect(readPackageVersion(read)).toBe(FALLBACK_VERSION);
  });

  test("version 字段缺失回退 fallback", () => {
    const read = () => JSON.stringify({});
    expect(readPackageVersion(read)).toBe(FALLBACK_VERSION);
  });

  test("version 非 string 回退 fallback", () => {
    const read = () => JSON.stringify({ version: 123 });
    expect(readPackageVersion(read)).toBe(FALLBACK_VERSION);
  });

  test("version 空串回退 fallback", () => {
    const read = () => JSON.stringify({ version: "" });
    expect(readPackageVersion(read)).toBe(FALLBACK_VERSION);
  });

  test("默认真实读取返回非空 string 不抛", () => {
    const v = readPackageVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});
