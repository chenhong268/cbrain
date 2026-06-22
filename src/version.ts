import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/** 版本解析全部失败时的回退值（compiled binary 等无 package.json 场景）。 */
export const FALLBACK_VERSION = "0.0.0-unknown" as const;

type FileReader = (path: string) => string;

/**
 * 安全解析当前版本号。
 * - source / npm installed：读 import.meta.url 相对的 ../package.json
 * - compiled binary ($bunfs) 或 package.json 缺失/损坏：回退 FALLBACK_VERSION
 *
 * 默认参数显式传 "utf-8" 以选返回 string 的 readFileSync overload；
 * 通过依赖注入 read 实现可测，避免 bun module mock。
 */
export function readPackageVersion(
  read: FileReader = (path) => readFileSync(path, "utf-8"),
): string {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(read(pkgPath)) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // 路径不存在 / JSON 损坏 / 字段无效 → 尝试下一个候选
    }
  }
  return FALLBACK_VERSION;
}

export const version: string = readPackageVersion();
