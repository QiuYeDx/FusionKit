import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface ProjectManifest {
  readonly version: string;
  readonly devDependencies: {
    readonly electron: string;
    readonly react: string;
  };
}

const projectRoot = process.cwd();
const readProjectFile = (relativePath: string) =>
  readFileSync(path.join(projectRoot, relativePath), "utf8");
const manifest = JSON.parse(
  readProjectFile("package.json"),
) as ProjectManifest;

describe("project build metadata", () => {
  it("keeps current release documentation synchronized with package.json", () => {
    const appVersion = manifest.version;
    const changelog = readProjectFile("CHANGELOG.md");
    const readme = readProjectFile("README.md");
    const readmeEn = readProjectFile("README.en.md");

    expect(changelog).toContain(`## [${appVersion}] -`);
    // While the changelog marks the version as in development, both READMEs say the
    // branch is that development version; a release must drop the notice.
    const inDevelopment = changelog.includes(`## [${appVersion}] - 开发中`);
    if (inDevelopment) {
      expect(readme).toContain(`**${appVersion} 开发版本**`);
      expect(readmeEn).toContain(`**${appVersion} development version**`);
    } else {
      expect(readme).not.toContain(`${appVersion} 开发版本`);
      expect(readmeEn).not.toContain(`${appVersion} development version`);
    }
  });

  it("keeps current Electron documentation synchronized with package.json", () => {
    const electronVersion = manifest.devDependencies.electron;
    const reactVersion = manifest.devDependencies.react;
    // The READMEs name major versions; the exact ones live in package.json.
    const major = (version: string) => version.replace(/^[^\d]*/, "").split(".")[0];
    const stack = `Electron ${major(electronVersion)} · React ${major(reactVersion)} ·`;
    const badge = `img.shields.io/badge/Electron-${major(electronVersion)}-`;
    const readme = readProjectFile("README.md");
    const readmeEn = readProjectFile("README.en.md");

    expect(readme).toContain(`| 应用框架 | ${stack}`);
    expect(readmeEn).toContain(`| App | ${stack}`);
    expect(readme).toContain(badge);
    expect(readmeEn).toContain(badge);
    expect(
      readProjectFile("docs/electron-renderer-api-quick-reference.md"),
    ).toContain(`当前依赖 \`electron@${electronVersion}\``);
  });

  it("derives About-page framework versions from the package-backed Vite defines", () => {
    const viteConfig = readProjectFile("vite.config.ts");
    const envTypes = readProjectFile("src/vite-env.d.ts");
    const aboutPage = readProjectFile("src/pages/About/index.tsx");

    expect(viteConfig).toContain(
      "const electronVersion = pkg.devDependencies.electron",
    );
    expect(viteConfig).toContain(
      "'import.meta.env.VITE_ELECTRON_VERSION': JSON.stringify(electronVersion)",
    );
    expect(viteConfig).toContain(
      "const reactVersion = pkg.devDependencies.react",
    );
    expect(viteConfig).toContain(
      "'import.meta.env.VITE_REACT_VERSION': JSON.stringify(reactVersion)",
    );
    expect(envTypes).toContain("readonly VITE_ELECTRON_VERSION?: string");
    expect(envTypes).toContain("readonly VITE_REACT_VERSION?: string");
    expect(aboutPage).toContain(
      "import.meta.env.VITE_ELECTRON_VERSION",
    );
    expect(aboutPage).toContain("import.meta.env.VITE_REACT_VERSION");
    expect(aboutPage).not.toMatch(/Electron \d+(?:\.\d+)* \+ React \d+/);
  });
});
