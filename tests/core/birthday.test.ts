import { describe, test, expect } from "bun:test";
import { extractBirthday, getZodiac } from "../../src/core/birthday.js";

describe("getZodiac", () => {
  test("9/22 = 处女座", () => expect(getZodiac(9, 22)).toBe("♍️ 处女座"));
  test("9/23 = 天秤座", () => expect(getZodiac(9, 23)).toBe("♎️ 天秤座"));
  test("1/1 = 摩羯座", () => expect(getZodiac(1, 1)).toBe("♑️ 摩羯座"));
  test("12/31 = 摩羯座", () => expect(getZodiac(12, 31)).toBe("♑️ 摩羯座"));
  test("3/21 = 白羊座", () => expect(getZodiac(3, 21)).toBe("♈️ 白羊座"));
});

describe("extractBirthday", () => {
  test("ISO date — 生日：1984-09-25", () => {
    const result = extractBirthday("- 生日：1984-09-25");
    expect(result).not.toBeNull();
    expect(result!.birthday).toBe("1984-09-25");
    expect(result!.zodiac).toBe("♎️ 天秤座");
    expect(result!.age).toBeGreaterThan(0);
  });

  test("Chinese year+month with bold — **出生**：1960年4月", () => {
    const result = extractBirthday("- **出生**：1960年4月");
    expect(result).not.toBeNull();
    expect(result!.birthday).toBe("1960年4月");
    expect(result!.zodiac).toBe("♈️ 白羊座"); // 4月15日 = 白羊座（3/21-4/19）
    expect(result!.age).toBeGreaterThan(0);
  });

  test("Chinese year only — **出生**：1976年", () => {
    const result = extractBirthday("- **出生**：1976年");
    expect(result).not.toBeNull();
    expect(result!.birthday).toBe("1976年");
    expect(result!.zodiac).toBeUndefined();
    expect(result!.age).toBe(new Date().getFullYear() - 1976);
  });

  test("no birthday returns null", () => {
    expect(extractBirthday("这是一段没有生日信息的文字")).toBeNull();
  });

  test("table format — | 1905 | 出生于维也纳", () => {
    const result = extractBirthday("| 1905 | 出生于维也纳 |");
    expect(result).not.toBeNull();
    expect(result!.birthday).toBe("1905年");
    expect(result!.zodiac).toBeUndefined();
  });

  test("bold markers compatibility", () => {
    const result = extractBirthday("- **生日**：2000-06-15");
    expect(result).not.toBeNull();
    expect(result!.birthday).toBe("2000-06-15");
    expect(result!.zodiac).toBe("♊️ 双子座");
  });

  test("zodiac boundary — Sep 22 vs Sep 23", () => {
    const r22 = extractBirthday("- 生日：2000-09-22");
    const r23 = extractBirthday("- 生日：2000-09-23");
    expect(r22!.zodiac).toBe("♍️ 处女座");
    expect(r23!.zodiac).toBe("♎️ 天秤座");
  });
});
