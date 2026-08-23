import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface ProjectManifest {
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
  it("keeps current Electron documentation synchronized with package.json", () => {
    const electronVersion = manifest.devDependencies.electron;
    const reactVersion = manifest.devDependencies.react;
    const frameworkStack = `Electron ${electronVersion} + React ${reactVersion}`;

    expect(readProjectFile("README.md")).toContain(
      `| 框架 | ${frameworkStack} |`,
    );
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
