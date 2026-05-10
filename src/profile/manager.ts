import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  profileEntrySchema,
  type ProfileEntry,
  type ProfileFile,
  type ProfileFilter,
  type ProfileModule,
} from "./schema.js";

const MAIN_FILE = "profile.yaml";
const MODULES_DIR = "profile.d";

export class ProfileManager {
  private entries = new Map<string, ProfileEntry>();
  private entrySource = new Map<string, string>(); // id → file path
  private mainPath: string;
  private modulesDir: string;
  private modules: { name: string; enabled: boolean; count: number }[] = [];
  private user: { id: string; display_name?: string } = { id: "default" };

  constructor(dataDir: string) {
    this.mainPath = join(dataDir, MAIN_FILE);
    this.modulesDir = join(dataDir, MODULES_DIR);
  }

  load(): void {
    this.entries.clear();
    this.entrySource.clear();
    this.modules = [];

    // Load main profile
    if (existsSync(this.mainPath)) {
      const file = this.parseFile(this.mainPath);
      if (file) {
        this.user = file.user ?? { id: "default" };
        this.ingestEntries(file.entries, this.mainPath);
      }
    }

    // Load modules
    if (existsSync(this.modulesDir)) {
      const files = readdirSync(this.modulesDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
      for (const f of files) {
        const path = join(this.modulesDir, f);
        const mod = this.parseModule(path);
        if (!mod) continue;
        this.modules.push({
          name: mod.module,
          enabled: mod.enabled !== false,
          count: mod.enabled !== false ? mod.entries.length : 0,
        });
        if (mod.enabled === false) continue;
        this.ingestEntries(mod.entries, path);
      }
    }
  }

  reload(): void {
    this.load();
  }

  getEntries(filter?: ProfileFilter): ProfileEntry[] {
    let result = Array.from(this.entries.values());
    if (!filter) return result;

    if (filter.scope) result = result.filter(e => e.scope === filter.scope);
    if (filter.category) result = result.filter(e => e.category === filter.category);
    if (filter.type) result = result.filter(e => e.type === filter.type);
    if (filter.ids) result = result.filter(e => filter.ids!.includes(e.id));
    if (filter.tags && filter.tags.length > 0) {
      result = result.filter(e => filter.tags!.some(t => e.tags?.includes(t)));
    }
    return result;
  }

  getEntry(id: string): ProfileEntry | undefined {
    return this.entries.get(id);
  }

  updateEntries(entries: Record<string, unknown>[]): ProfileEntry[] {
    const now = new Date().toISOString().slice(0, 10);
    const updated: ProfileEntry[] = [];

    for (const raw of entries) {
      const entry = profileEntrySchema.parse({ ...raw, updated_at: now });
      this.entries.set(entry.id, entry);
      updated.push(entry);

      // Write back to source file, or main file for new entries
      const sourcePath = this.entrySource.get(entry.id) ?? this.mainPath;
      this.entrySource.set(entry.id, sourcePath);
      this.writeBack(sourcePath);
    }

    return updated;
  }

  removeEntries(ids: string[]): string[] {
    const removed: string[] = [];
    const affectedFiles = new Set<string>();

    for (const id of ids) {
      if (!this.entries.has(id)) continue;
      const sourcePath = this.entrySource.get(id);
      if (sourcePath) affectedFiles.add(sourcePath);
      this.entries.delete(id);
      this.entrySource.delete(id);
      removed.push(id);
    }

    for (const path of Array.from(affectedFiles)) {
      this.writeBack(path);
    }

    return removed;
  }

  getModules(): { name: string; enabled: boolean; count: number }[] {
    return [...this.modules];
  }

  getUser(): { id: string; display_name?: string } {
    return this.user;
  }

  getStats(): { total: number; byScope: Record<string, number>; byType: Record<string, number>; modules: number } {
    const byScope: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const e of Array.from(this.entries.values())) {
      byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    return { total: this.entries.size, byScope, byType, modules: this.modules.length };
  }

  private ingestEntries(entries: ProfileEntry[], sourcePath: string): void {
    for (const raw of entries) {
      const entry = profileEntrySchema.parse(raw);
      this.entries.set(entry.id, entry);
      this.entrySource.set(entry.id, sourcePath);
    }
  }

  private parseFile(path: string): ProfileFile | null {
    try {
      const content = readFileSync(path, "utf-8");
      const data = yamlParse(content);
      if (!data || !Array.isArray(data.entries)) return null;
      return data as ProfileFile;
    } catch {
      return null;
    }
  }

  private parseModule(path: string): ProfileModule | null {
    try {
      const content = readFileSync(path, "utf-8");
      const data = yamlParse(content);
      if (!data || !Array.isArray(data.entries)) return null;
      return data as ProfileModule;
    } catch {
      return null;
    }
  }

  private writeBack(path: string): void {
    // Collect all entries belonging to this file
    const fileEntries: ProfileEntry[] = [];
    for (const [id, entry] of Array.from(this.entries)) {
      if (this.entrySource.get(id) === path) {
        fileEntries.push(entry);
      }
    }

    // Determine if it's a module or main file
    const isModule = path.startsWith(this.modulesDir);
    const content = isModule
      ? this.buildModuleContent(path, fileEntries)
      : this.buildMainContent(fileEntries);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  private buildMainContent(entries: ProfileEntry[]): string {
    const data: ProfileFile = {
      version: 1,
      user: this.user,
      entries,
    };
    return yamlStringify(data as unknown as Record<string, unknown>, { lineWidth: 0 });
  }

  private buildModuleContent(path: string, entries: ProfileEntry[]): string {
    // Preserve module metadata from original parse
    const original = this.parseModule(path);
    const data: ProfileModule = {
      version: 1,
      module: original?.module ?? path.split("/").pop()!.replace(/\.ya?ml$/, ""),
      description: original?.description,
      enabled: original?.enabled ?? true,
      user: original?.user ?? { id: this.user.id },
      entries,
    };
    return yamlStringify(data as unknown as Record<string, unknown>, { lineWidth: 0 });
  }
}
