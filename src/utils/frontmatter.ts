import matter from "gray-matter";
import { readFileSync, writeFileSync } from "node:fs";

export interface PageFrontmatter {
  title: string;
  type: "entity" | "concept" | "record" | "insight";
  slug: string;
  tags?: string[];
  tier?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export function parseFrontmatter(content: string): {
  frontmatter: PageFrontmatter;
  body: string;
} {
  const { data, content: body } = matter(content);
  return { frontmatter: data as PageFrontmatter, body: body.trimEnd() };
}

export function stringifyFrontmatter(
  frontmatter: PageFrontmatter,
  body: string
): string {
  return matter.stringify(body, frontmatter);
}

export function readPageFile(filePath: string): {
  frontmatter: PageFrontmatter;
  body: string;
} {
  const raw = readFileSync(filePath, "utf-8");
  return parseFrontmatter(raw);
}

export function writePageFile(
  filePath: string,
  frontmatter: PageFrontmatter,
  body: string
): void {
  const content = stringifyFrontmatter(frontmatter, body);
  writeFileSync(filePath, content, "utf-8");
}
