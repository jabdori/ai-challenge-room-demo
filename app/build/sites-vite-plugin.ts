import {
  access,
  copyFile,
  cp,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

interface CopySitesMetadataOptions {
  root: string;
  outDir: string;
}

interface SitesMetadataCopyPluginOptions {
  root?: string;
  outDir?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function copySitesMetadata({
  root,
  outDir,
}: CopySitesMetadataOptions): Promise<void> {
  const hostingSource = join(root, ".openai", "hosting.json");
  const drizzleSource = join(root, "drizzle");
  const hostingExists = await pathExists(hostingSource);
  const drizzleExists = await pathExists(drizzleSource);
  if (!hostingExists && !drizzleExists) {
    return;
  }

  const metadataOutDir = join(outDir, ".openai");
  await mkdir(metadataOutDir, { recursive: true });
  if (hostingExists) {
    await copyFile(hostingSource, join(metadataOutDir, "hosting.json"));
  }
  if (drizzleExists) {
    await cp(drizzleSource, join(metadataOutDir, "drizzle"), {
      recursive: true,
      force: true,
    });
  }
}

export function sitesMetadataCopyPlugin(
  options: SitesMetadataCopyPluginOptions = {},
): Plugin {
  let root = options.root;
  let outDir = options.outDir;

  return {
    name: "sites-metadata-copy",
    apply: "build",
    configResolved(config) {
      root ??= config.root;
      outDir ??= resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      if (!root || !outDir) {
        throw new Error("Sites metadata copy plugin의 build 경로가 설정되지 않았습니다.");
      }
      await copySitesMetadata({ root, outDir });
    },
  };
}
