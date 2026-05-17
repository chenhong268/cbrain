export interface BirthdayInfo {
  birthday: string;
  age: number;
  zodiac?: string;
  shengxiao?: string;
}

const ZODIAC: { sign: string; end: [number, number] }[] = [
  { sign: "♑️ 摩羯座", end: [1, 19] },
  { sign: "♒️ 水瓶座", end: [2, 18] },
  { sign: "♓️ 双鱼座", end: [3, 20] },
  { sign: "♈️ 白羊座", end: [4, 19] },
  { sign: "♉️ 金牛座", end: [5, 20] },
  { sign: "♊️ 双子座", end: [6, 21] },
  { sign: "♋️ 巨蟹座", end: [7, 22] },
  { sign: "♌️ 狮子座", end: [8, 22] },
  { sign: "♍️ 处女座", end: [9, 22] },
  { sign: "♎️ 天秤座", end: [10, 23] },
  { sign: "♏️ 天蝎座", end: [11, 22] },
  { sign: "♐️ 射手座", end: [12, 21] },
  { sign: "♑️ 摩羯座", end: [12, 31] },
];

const SHENGXIAO = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

export function getShengxiao(year: number): string {
  return SHENGXIAO[(year - 4) % 12];
}

export function getZodiac(month: number, day: number): string {
  for (const z of ZODIAC) {
    const [em, ed] = z.end;
    if (month < em || (month === em && day <= ed)) {
      return z.sign;
    }
  }
  return "♑️ 摩羯座";
}

function calcAge(year: number, month?: number, day?: number): number {
  const now = new Date();
  let age = now.getFullYear() - year;
  if (month != null) {
    const m = month;
    const d = day ?? 15;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) {
      age--;
    }
  }
  return age;
}

const LABEL_RE = /\*{0,2}(?:生日|出生)\*{0,2}\s*[：:]\s*/;

export function extractBirthday(body: string): BirthdayInfo | null {
  for (const line of body.split("\n")) {
    if (!LABEL_RE.test(line)) continue;

    // Format 1: ISO date — 1984-09-25
    let m = line.match(/\*{0,2}(?:生日|出生)\*{0,2}\s*[：:]\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      const [, ys, ms, ds] = m;
      const year = +ys, month = +ms, day = +ds;
      return { birthday: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, age: calcAge(year, month, day), zodiac: getZodiac(month, day), shengxiao: getShengxiao(year) };
    }

    // Format 2: Chinese year+month — 1960年4月
    m = line.match(/\*{0,2}(?:生日|出生)\*{0,2}\s*[：:]\s*(\d{4})年(\d{1,2})月/);
    if (m) {
      const [, ys, ms] = m;
      const year = +ys, month = +ms;
      return { birthday: `${year}年${month}月`, age: calcAge(year, month), zodiac: getZodiac(month, 15), shengxiao: getShengxiao(year) };
    }

    // Format 3: Chinese year only — 1976年
    m = line.match(/\*{0,2}(?:生日|出生)\*{0,2}\s*[：:]\s*(\d{4})年/);
    if (m) {
      const year = +m[1];
      return { birthday: `${year}年`, age: calcAge(year), shengxiao: getShengxiao(year) };
    }
  }

  // Format 4: table row — | 1905 | 出生于...
  const tableMatch = body.match(/\|\s*(\d{4})\s*\|\s*出生/);
  if (tableMatch) {
    const year = +tableMatch[1];
    return { birthday: `${year}年`, age: calcAge(year), shengxiao: getShengxiao(year) };
  }

  return null;
}
