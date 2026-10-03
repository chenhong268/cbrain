/** Closed report proof, shared by admission and its displayed source excerpt.
 * undefined = other query; null = recognized query without verified evidence. */
export function getQuarterlyReportEvidence(query: string, evidence: string): string | null | undefined {
  if (typeof query !== "string" || typeof evidence !== "string") return undefined;
  const normalized = query.normalize("NFKC").toLowerCase().trim();
  const words = normalized.split(/[ \t]+/u);
  if (words.length !== 7 || normalized.length > 64
    || !/^[\p{Script=Han}]{2,24}$/u.test(words[0]!)
    || !/^[a-z][a-z0-9]{1,23}$/u.test(words[1]!)
    || !/^[\p{Script=Han}]{2,24}$/u.test(words[2]!)
    || !/^[一二三四]季度$/u.test(words[3]!) || words[4] !== "销售下滑"
    || !/^20\d{2}q[1-4]$/u.test(words[5]!) || words[6] !== "财报") return undefined;
  if (evidence.length > 100_000) return null;
  const quarter = "一二三四".indexOf(words[3]![0]!) + 1;
  const year = words[5]!.slice(0, 4);
  if (words[5]!.at(-1) !== String(quarter)) return null;
  const period = new RegExp(`${year}年?第?${words[3]![0]}季度|${year}\\s*q${quarter}|q${quarter}\\s*${year}`, "u");
  const identity = new RegExp(`^${words[0]}\\s+${words[1]}$`, "u");
  const cause = new RegExp(`^主要受${words[2]}竞争影响(?:[;；].{1,64})?$`, "u");
  const originalLines = evidence.split(/\r?\n/u);
  const lines = originalLines.map((line) => line.normalize("NFKC").toLowerCase());
  const headings: string[] = [];
  const originalHeadings: string[] = [];
  const prefaceOpen: boolean[] = [];
  const qualified: boolean[] = [];
  const qualification = /(?:未经|未确认|未证实|待核实|待验证|假设|草稿|模拟|猜测|作废|撤回|已否认|不明确)/u;
  const cells = (line: string): string[] => line.trim().startsWith("|") && line.trim().endsWith("|")
    ? line.trim().slice(1, -1).split("|").map((cell) => cell.trim()) : [];
  for (let i = 0; i < lines.length - 2; i++) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(lines[i]!);
    if (heading) {
      const level = heading[1]!.length - 1;
      prefaceOpen.fill(false);
      headings.length = originalHeadings.length = prefaceOpen.length = qualified.length = level;
      headings[level] = heading[2]!;
      originalHeadings[level] = originalLines[i]!;
      prefaceOpen[level] = true;
      qualified[level] = false;
      continue;
    }
    const header = cells(lines[i]!);
    if (header.length > 0) prefaceOpen.fill(false);
    else if (qualification.test(lines[i]!)) {
      for (let level = 0; level < qualified.length; level++) {
        if (prefaceOpen[level]) qualified[level] = true;
      }
    }
    if (qualified.some(Boolean)) continue;
    if (header.length !== 4 || header[0] !== "产品" || header[1] !== `q${quarter}销售额`
      || header[2] !== "固定汇率同比" || header[3] !== "官方披露的主要原因"
      || !period.test(headings[0] ?? "")) continue;
    // A nested report period or speculative heading cannot borrow the root period.
    if (headings.some((text) => /(?:未确认|待核实|预计|预测|假设|草稿|模拟|猜测|否认)/u.test(text)
      || [...text.matchAll(/20\d{2}/gu)].some(([value]) => value !== year)
      || [...text.matchAll(/q([1-4])|第?([一二三四])季度/gu)].some(([, digit, han]) =>
        (digit ? Number(digit) : "一二三四".indexOf(han!) + 1) !== quarter))) continue;
    const separator = cells(lines[i + 1]!);
    if (separator.length !== 4 || !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
    let matchedRow: string | undefined;
    let end = i + 2;
    for (; end < lines.length; end++) {
      const row = cells(lines[end]!);
      if (row.length !== 4 || row[0] === "产品" || row.every((cell) => /^:?-{3,}:?$/u.test(cell))) break;
      if (!identity.test(row[0]!) || !/^-\d+(?:\.\d+)?%$/u.test(row[2]!)
        || Number.parseFloat(row[2]!) >= 0 || !cause.test(row[3]!)
        || /(?:[不未无尚待吗么呢?？]|可能|或许|是否|并非|暂缺|调查中|猜测|否认)/u.test(row[3]!)) continue;
      const excerpt = `${originalHeadings[0]}\n${originalLines[i]}\n${originalLines[end]}`;
      if (excerpt.length <= 200) matchedRow ??= excerpt;
    }
    if (!matchedRow) continue;
    let withdrawn = false;
    for (; end < lines.length && !/^#{1,6}\s/u.test(lines[end]!) && cells(lines[end]!).length === 0; end++) {
      if (qualification.test(lines[end]!)) { withdrawn = true; break; }
    }
    if (!withdrawn) return matchedRow;
  }
  return null;
}

