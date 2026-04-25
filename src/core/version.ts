import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { PageManager } from "./page.js";
import { parseFrontmatter, stringifyFrontmatter } from "../utils/frontmatter.js";

export interface VersionInfo {
  version: number;
  created_at: string;
}

export interface VersionDetail extends VersionInfo {
  content: string;
  frontmatter: string | null;
}

export class VersionManager {
  private db: CBrainDB;
  private pages: PageManager;
  private vaultPath: string;

  constructor(db: CBrainDB, pages: PageManager, vaultPath: string) {
    this.db = db;
    this.pages = pages;
    this.vaultPath = vaultPath;
  }

  createVersion(slug: string): number | null {
    const page = this.pages.getBySlug(slug);
    if (!page) return null;

    const filePath = join(this.vaultPath, page.file_path);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    return this.db.createVersion(
      slug,
      body,
      frontmatter ? JSON.stringify(frontmatter) : undefined
    );
  }

  getVersions(slug: string): VersionInfo[] {
    return this.db.getVersions(slug);
  }

  getVersion(slug: string, version: number): VersionDetail | null {
    return this.db.getVersion(slug, version);
  }

  revertToVersion(slug: string, version: number): boolean {
    const ver = this.db.getVersion(slug, version);
    if (!ver) return false;

    const page = this.pages.getBySlug(slug);
    if (!page) return false;

    let fm = page.frontmatter;
    if (ver.frontmatter) {
      try {
        fm = JSON.parse(ver.frontmatter);
      } catch {
        // keep existing frontmatter
      }
    }
    fm = { ...fm, updated_at: new Date().toISOString() };

    const filePath = join(this.vaultPath, page.file_path);
    const content = stringifyFrontmatter(fm, ver.content);
    writeFileSync(filePath, content, "utf-8");

    // Create a version snapshot before reverting
    this.createVersion(slug);

    // Re-sync the page in DB
    this.pages.update(slug, { body: ver.content });

    return true;
  }
}
