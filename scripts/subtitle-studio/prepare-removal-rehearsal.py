#!/usr/bin/env python3
"""Create an audited I1-only removal rehearsal. Never edits the source checkout.

Usage: python3 scripts/subtitle-studio/prepare-removal-rehearsal.py [--build]
The destination is always a newly-created fusionkit-studio-removal-* in the OS temp directory.
Dependencies are reused through one node_modules symlink; source files are copies.
No Electron process, package installation, packaging or publication is performed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


SOURCE = Path(__file__).resolve().parents[2]
PREFIX = "fusionkit-studio-removal-"
REMOVAL_PREFIXES = (
    "electron/main/translation/", "electron/main/local-subtitle/",
    "electron/preload/local-subtitle-", "electron/preload/subtitle-translation-",
    "src/pages/Tools/Subtitle/SubtitleTranslator/", "src/pages/Tools/Subtitle/LocalSubtitleTranscriber/",
    "src/components/local-subtitle/", "src/services/subtitle/", "src/services/local-subtitle/",
    "src/type/localSubtitle", "src/utils/subtitle", "test/translation/", "test/local-subtitle/",
    "resources/local-subtitle/", "scripts/local-subtitle/", "build/local-subtitle-resources/",
)
REMOVAL_FILES = {
    "src/renderer/subtitle.ts", "src/workers/subtitleTokenEstimate.worker.ts",
    "src/constants/subtitle.ts", "src/utils/tokenEstimate.test.ts",
    "src/type/subtitleTranslationIpc.ts", "src/type/subtitleUsage.ts", "src/type/generatedSubtitleImport.ts",
    "src/agent/task-model-config.ts", "src/agent/task-model-config.test.ts",
    "src/agent/translation-slice-config.ts", "src/agent/translation-slice-config.test.ts",
    "src/agent/tool-executor-translation.test.ts", "src/agent/subtitle-recovery-intent.ts",
    "test/subtitle-studio/i1-coexistence-ui.test.ts",
    "test/subtitle-studio/i1-legacy-real-ui.test.ts",
    "test/subtitle-studio/i1-legacy-recovery-ui.test.ts",
}
STORE_KEEP = {"useSubtitleConverterStore.ts", "useSubtitleConverterStore.test.ts", "useSubtitleExtractorStore.ts"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def removed(name):
    return name in REMOVAL_FILES or name.startswith(REMOVAL_PREFIXES) or (
        name.startswith("src/store/tools/subtitle/") and Path(name).name not in STORE_KEEP
    )


def run(command, cwd, logfile=None):
    if logfile:
        with logfile.open("w", encoding="utf-8") as output:
            result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, check=False)
        return result.returncode
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


AST_EDITOR = r'''
const fs = require('node:fs');
const path = require('node:path');
const ts = require(process.argv[1]);
const root = process.argv[2];
const operations = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const op of operations) {
  const file = path.join(root, op.file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const seen = new Map();
  const mark = name => seen.set(name, (seen.get(name) || 0) + 1);
  const result = ts.transform(source, [context => {
    const visit = node => {
      if (ts.isImportDeclaration(node)) {
        const module = node.moduleSpecifier.text;
        if ((op.dropImports || []).some(prefix => module === prefix || module.startsWith(prefix))) { mark('import:' + module); return undefined; }
        const clause = node.importClause;
        if (clause) {
          const keep = name => !(op.dropBindings || []).includes(name);
          const name = clause.name && keep(clause.name.text) ? clause.name : undefined;
          let bindings = clause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            const elements = bindings.elements.filter(element => keep(element.name.text));
            bindings = elements.length ? ts.factory.updateNamedImports(bindings, elements) : undefined;
          }
          if (!name && !bindings) return undefined;
          return ts.factory.updateImportDeclaration(node, node.modifiers, ts.factory.updateImportClause(clause, clause.isTypeOnly, name, bindings), node.moduleSpecifier, node.attributes);
        }
      }
      const declared = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (declared && (op.dropNames || []).includes(declared)) { mark('name:' + declared); return undefined; }
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name && (op.dropNames || []).includes(declaration.name.getText(source)))) {
        mark('variable:' + node.declarationList.declarations[0].name.getText(source)); return undefined;
      }
      if (ts.isPropertyAssignment(node) && (op.dropProperties || []).includes(node.name.getText(source).replaceAll('"', '').replaceAll("'", ''))) return undefined;
      if (ts.isObjectLiteralExpression(node) && ts.isArrayLiteralExpression(node.parent) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'id' && ts.isStringLiteral(property.initializer) && (op.dropIds || []).includes(property.initializer.text))) return undefined;
      if (ts.isLiteralTypeNode(node) && ts.isUnionTypeNode(node.parent) && ts.isStringLiteral(node.literal) && (op.dropUnionLiterals || []).includes(node.literal.text)) return undefined;
      if (ts.isJsxSelfClosingElement(node) && (op.dropJsx || []).some(name => node.tagName.getText(source) === name || node.getText(source).includes('<' + name + ' ' ) || node.getText(source).includes('<' + name + '/>'))) return undefined;
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && (op.dropCases || []).includes(node.expression.text)) return undefined;
      if (ts.isExpressionStatement(node)) {
        if (node.expression.getText(source).startsWith('expect(') && (op.dropExpressionText || []).some(text => node.getText(source).includes(text))) return undefined;
        if (ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'it' && ts.isStringLiteral(node.expression.arguments[0]) && (op.dropTests || []).includes(node.expression.arguments[0].text)) return undefined;
        if (ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'describe' && ts.isStringLiteral(node.expression.arguments[0]) && (op.dropSuites || []).includes(node.expression.arguments[0].text)) return undefined;
      }
      if (ts.isStringLiteral(node) && ts.isArrayLiteralExpression(node.parent) && (op.dropArrayStrings || []).includes(node.text)) return undefined;
      if (ts.isArrayLiteralExpression(node) && ts.isArrayLiteralExpression(node.parent) && node.elements.length && ts.isStringLiteral(node.elements[0]) && (op.dropArrayStrings || []).includes(node.elements[0].text)) return undefined;
      if (ts.isJsxSelfClosingElement(node) && (op.dropJsxText || []).some(text => node.getText(source).includes(text))) return undefined;
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit);
  }]);
  for (const name of op.requireNames || []) {
    if (!seen.has('name:' + name) && !seen.has('variable:' + name)) throw new Error('Expected declaration absent: ' + op.file + ':' + name);
  }
  const text = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0]);
  result.dispose();
  fs.writeFileSync(file, text);
}
'''


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--build", action="store_true", help="run root Vite build and local checks in the new copy")
    options = args.parse_args()
    if not (SOURCE / ".git").exists() or not (SOURCE / "node_modules/typescript").exists():
        raise SystemExit("Run from a FusionKit checkout with its existing dependencies available.")
    temporary_root = Path(tempfile.gettempdir()).resolve()
    destination = Path(tempfile.mkdtemp(prefix=PREFIX, dir=temporary_root)).resolve()
    if destination.parent != temporary_root or not destination.name.startswith(PREFIX) or destination == SOURCE:
        raise RuntimeError("Unsafe rehearsal destination")
    marker = destination / ".subtitle-studio-removal-owner.json"
    marker.write_text(json.dumps({"source": str(SOURCE), "created": time.time()}, indent=2) + "\n", encoding="utf-8")
    print(str(destination), flush=True)
    manifest = {"source": str(SOURCE), "destination": str(destination), "head": run(["git", "rev-parse", "HEAD"], SOURCE),
                "copied": {}, "removed": {}, "modified": {}, "created": {}, "checks": {},
                "scope": "I1 source-only removal rehearsal; no packaging, real ASR, Electron or root checkout changes"}
    manifest_path = destination / "removal-manifest.json"
    def save_manifest():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    def read(name):
        return (destination / name).read_text(encoding="utf-8")
    def write(name, text):
        file = destination / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
    def replace(name, old, new, count=1):
        text = read(name)
        if text.count(old) != count:
            raise RuntimeError(f"Expected {count} exact matches in {name}: {old[:100]!r}; saw {text.count(old)}")
        write(name, text.replace(old, new))
    def between(name, start, end, replacement=""):
        text = read(name)
        if text.count(start) != 1 or text.count(end) != 1:
            raise RuntimeError(f"Ambiguous boundaries in {name}: {start!r}, {end!r}")
        a, b = text.index(start), text.index(end)
        if b <= a:
            raise RuntimeError(f"Reversed boundaries in {name}")
        write(name, text[:a] + replacement + text[b:])

    try:
        names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=SOURCE).decode().split("\0")
        for name in sorted(set(names) - {""}):
            if name.startswith(("node_modules/", ".git/", "dist/", "dist-electron/", "release/", "test-results/")):
                continue
            original = SOURCE / name
            if not original.exists():
                continue
            if original.is_symlink() or not original.is_file():
                raise RuntimeError(f"Source must be an ordinary file: {name}")
            data = original.read_bytes()
            if removed(name):
                manifest["removed"][name] = sha(data)
                continue
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            shutil.copymode(original, target)
            manifest["copied"][name] = sha(data)
        if os.name == "nt":
            subprocess.run(["node", "-e", "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')", str(SOURCE / "node_modules"), str(destination / "node_modules")], check=True)
        else:
            (destination / "node_modules").symlink_to(SOURCE / "node_modules", target_is_directory=True)
        manifest["dependencies"] = {"path": str(SOURCE / "node_modules"), "lockSha256": sha((SOURCE / "pnpm-lock.yaml").read_bytes()), "installationPerformed": False}

        # Preserve the complete shared Explorer resolver, without its legacy service dependencies.
        resolver_source = SOURCE / "electron/main/local-subtitle/windows-explorer-drop-resolver.ts"
        resolver = resolver_source.read_text(encoding="utf-8")
        resolver = resolver.replace('import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";\n', '')
        resolver = resolver.replace('import type { LocalSubtitleInputSelectionSource } from "@/type/localSubtitleIpc";\n', '')
        resolver = resolver.replace('import { LocalSubtitleAuthorizationError } from "./authorizations";',
                                    'import { NativeInputPathError } from "./input-path-error";\ntype NativeInputSelectionSource = "picker" | "drop";\nconst INPUT_LIMITS = { maxBatchFiles: 100, maxDisplayNameChars: 255 } as const;')
        resolver = resolver.replace("LOCAL_SUBTITLE_LIMITS", "INPUT_LIMITS").replace("LocalSubtitleInputSelectionSource", "NativeInputSelectionSource").replace("LocalSubtitleAuthorizationError", "NativeInputPathError").replace("resolveLocalSubtitleInputPaths", "resolveNativeInputPaths")
        if "local-subtitle" in resolver or "@/type/localSubtitle" in resolver:
            raise RuntimeError("Shared resolver still depends on the removed implementation")
        write("electron/main/fs/windows-explorer-drop-resolver.ts", resolver)
        authorizations = (SOURCE / "electron/main/local-subtitle/authorizations.ts").read_text(encoding="utf-8")
        error = authorizations[authorizations.index("export type LocalSubtitleAuthorizationErrorCode ="):authorizations.index("export type LocalSubtitleInputOperation =")]
        write("electron/main/fs/input-path-error.ts", error.replace("LocalSubtitleAuthorizationError", "NativeInputPathError"))
        manifest["retainedSharedResolver"] = {"source": str(resolver_source.relative_to(SOURCE)), "sourceSha256": sha(resolver_source.read_bytes()),
            "reason": "Native file selection and audio still use this complete Windows Explorer fallback; no inference, models, IPC or v1 state retained.",
            "limits": {"maxBatchFiles": 100, "maxDisplayNameChars": 255}}
        for name in ["electron/main/audio/ipc.ts", "electron/main/fs/native-file-selection-ipc.ts"]:
            text = read(name).replace('"../local-subtitle/authorizations"', '"../fs/input-path-error"').replace('"../local-subtitle/windows-explorer-drop-resolver"', '"../fs/windows-explorer-drop-resolver"')
            write(name, text.replace("LocalSubtitleAuthorizationError", "NativeInputPathError").replace("resolveLocalSubtitleInputPaths", "resolveNativeInputPaths"))
        resolver_test = (SOURCE / "test/local-subtitle/windowsExplorerDropResolver.test.ts").read_text(encoding="utf-8")
        write("test/native-file-selection/windowsExplorerDropResolver.test.ts", resolver_test.replace("../../electron/main/local-subtitle/windows-explorer-drop-resolver", "../../electron/main/fs/windows-explorer-drop-resolver").replace("../../electron/main/local-subtitle/authorizations", "../../electron/main/fs/input-path-error").replace("LocalSubtitleAuthorizationError", "NativeInputPathError").replace("resolveLocalSubtitleInputPaths", "resolveNativeInputPaths"))
        name = "test/native-file-selection/ipc.test.ts"
        write(name, read(name).replace("../../electron/main/local-subtitle/windows-explorer-drop-resolver", "../../electron/main/fs/windows-explorer-drop-resolver").replace("resolveLocalSubtitleInputPaths", "resolveNativeInputPaths"))
        # Text translation uses only these pure formatting helpers from the mixed file.
        token_helpers = read("src/utils/tokenEstimate.ts")
        write("src/utils/tokenEstimate.ts", token_helpers[token_helpers.index("export const formatTokens ="):])

        # Remove whole legacy construction spans only between asserted, stable production anchors.
        between("electron/main/index.ts", "  const localSubtitleManagedResourceRoot =", "  setupNativeFileSelectionIPC();")
        replace("electron/main/index.ts", 'localSubtitleServerLifecycle?.prepareUpdateInstall() ??\n        Promise.resolve()', 'Promise.resolve()')
        between("src/main.tsx", '// 在渲染进程中接收进度更新', 'const root = ReactDOM.createRoot(')
        between("electron/preload/index.ts", 'const localSubtitleOwnerSessionRegistration =', 'const assertLegacyIpcChannelAllowed =')
        between("electron/preload/index.ts", "contextBridge.exposeInMainWorld(\n  'localSubtitleApi',", '// --------- Expose webUtils API')
        replace("electron/preload/index.ts", '  assertLegacyLocalSubtitleChannelAllowed(channel)\n', '', 2)
        replace("electron/preload/index.ts", '  assertLegacySubtitleTranslationChannelAllowed(channel)\n', '', 2)
        replace("src/vite-env.d.ts", "  localSubtitleApi: import('@/type/localSubtitleIpc').LocalSubtitleRendererApi\n", '')
        replace("src/vite-env.d.ts", "  subtitleTranslationApi: import('@/type/subtitleTranslationIpc').SubtitleTranslationRendererApi\n", '')
        replace("src/constants/router.ts", 'export const LOCAL_SUBTITLE_TRANSCRIBER_ROUTE =\n  "/tools/subtitle/local-transcriber" as const;\n', '')
        replace("src/constants/router.ts", '  "/tools/subtitle/translator": "menu.subtitle.translator",\n', '')
        replace("src/constants/router.ts", '  [LOCAL_SUBTITLE_TRANSCRIBER_ROUTE]: "menu.subtitle.local_transcriber",\n', '')

        translator_names = ["SubtitleSliceType", "TranslationOutputMode", "SubtitleModelApiFormat", "SubtitleOutputTokenParameter", "SubtitleTaskReadyExecutionBinding", "SubtitleTaskExecutionBinding", "TranslationRecoveryMode", "SubtitleTranslationRecovery", "TranslationRecoveryInputMode", "SubtitleTranslatorTask", "TranslationRecoveryCandidate", "TranslationRecoveryScanResult", "RecoveredSubtitleTaskDraft"]
        executor_names = ["executeQueueTranslate", "executeScanSubtitleRecoveryTasks", "executeQueueRecoveredSubtitleTranslate", "pendingAgentSelectionRevocations", "pendingAgentOutputDirectoryRevocations", "containsLegacyAgentTranslateAuthority", "getSubtitleTranslationApi", "scheduleAgentSelectionRevocation", "scheduleAgentOutputDirectoryRevocation", "flushPendingAgentTranslationRevocations"]
        schema_names = ["queueTranslateSchema", "scanSubtitleRecoveryTasksSchema", "queueRecoveredSubtitleTranslateSchema", "QueueTranslateArgs", "ScanSubtitleRecoveryTasksArgs", "QueueRecoveredSubtitleTranslateArgs"]
        operations = [
            {"file": "src/App.tsx", "dropImports": ["./pages/Tools/Subtitle/SubtitleTranslator", "./pages/Tools/Subtitle/LocalSubtitleTranscriber", "@/components/local-subtitle/", "@/constants/router"], "dropJsx": ["SubtitleTranslator", "LocalSubtitleTranscriber", "LocalSubtitleOverwriteRecoveryPrompt"]},
            {"file": "src/pages/Tools/index.tsx", "dropIds": ["translator", "localSubtitleTranscriber"]},
            {"file": "src/pages/Tools/_shared/toolMeta.ts", "dropImports": ["@/constants/router"], "dropProperties": ["translator", "localSubtitleTranscriber"], "dropUnionLiterals": ["translator", "localSubtitleTranscriber"]},
            {"file": "electron/main/index.ts", "dropImports": ["./translation/", "./local-subtitle/", "@/type/localSubtitleIpc"], "dropNames": ["localSubtitleServerLifecycle", "translationService", "subtitleTranslationDirectoryCapabilities"], "requireNames": ["localSubtitleServerLifecycle", "translationService", "subtitleTranslationDirectoryCapabilities"]},
            {"file": "electron/preload/index.ts", "dropImports": ["./local-subtitle-", "./subtitle-translation-", "@/type/localSubtitleIpc", "@/type/subtitleTranslationIpc"]},
            {"file": "src/type/subtitle.ts", "dropImports": ["@/type/model", "./subtitleUsage", "./subtitleTranslationIpc"], "dropNames": translator_names, "requireNames": translator_names},
            {"file": "src/store/agent/useAgentStore.ts", "dropImports": ["@/store/tools/subtitle/useSubtitleTranslatorStore"], "dropCases": ["translate"]},
            {"file": "src/agent/tools.ts", "dropBindings": ["queueTranslateSchema", "scanSubtitleRecoveryTasksSchema", "queueRecoveredSubtitleTranslateSchema", "executeQueueTranslate", "executeScanSubtitleRecoveryTasks", "executeQueueRecoveredSubtitleTranslate"], "dropProperties": ["queue_subtitle_translate", "scan_subtitle_recovery_tasks", "queue_recovered_subtitle_translate"]},
            {"file": "src/agent/tool-executor.ts", "dropImports": ["@/store/tools/subtitle/useSubtitleTranslatorStore", "@/store/useModelStore", "@/utils/tokenEstimate", "./translation-slice-config", "@/services/subtitle/", "./task-model-config"], "dropBindings": ["QueueTranslateArgs", "ScanSubtitleRecoveryTasksArgs", "QueueRecoveredSubtitleTranslateArgs", "SubtitleTranslatorTask", "SubtitleSliceType", "TranslationLanguage", "TranslationOutputMode"], "dropNames": executor_names, "requireNames": executor_names},
            {"file": "src/agent/tool-schemas.ts", "dropNames": schema_names, "requireNames": schema_names},
            {"file": "src/agent/tool-schemas.test.ts", "dropBindings": schema_names, "dropSuites": ["queue translate schema", "subtitle recovery schemas"]},
            {"file": "src/agent/types.ts", "dropUnionLiterals": ["translate", "subtitle_recovery_scan", "subtitle_recovery_queue"]},
            {"file": "src/pages/HomeAgent/SessionLogViewer.tsx", "dropProperties": ["subtitle_recovery_scan", "subtitle_recovery_queue"]},
            {"file": "src/pages/HomeAgent/index.tsx", "dropProperties": ["translate"], "dropJsxText": ["home:suggestion_translate_srt"]},
            {"file": "src/pages/Tools/_shared/ui/toolConfigDisclosureConsumers.test.ts", "dropNames": ["subtitleTranslatorSource"], "requireNames": ["subtitleTranslatorSource"], "dropTests": ["uses the shared disclosure for scheduled subtitle translation"]},
            {"file": "src/pages/Tools/_shared/ui/toolBooleanControlConsumers.test.ts", "dropArrayStrings": ["Subtitle/SubtitleTranslator/index.tsx", "Subtitle/LocalSubtitleTranscriber/index.tsx", "Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx"], "dropExpressionText": ['read("Subtitle/LocalSubtitleTranscriber/index.tsx")', 'read("Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx")']},
        ]
        subprocess.run(["node", "-e", AST_EDITOR, str(SOURCE / "node_modules/typescript"), str(destination)], input=json.dumps(operations), text=True, check=True)
        # Remove obsolete Agent prompt instructions, while preserving conversion/extraction/rename.
        orchestrator = read("src/agent/orchestrator.ts")
        start = orchestrator.index("## Workflow for Subtitle Recovery Requests")
        next_section = orchestrator.find("\n## ", start + 3)
        if next_section < 0:
            next_section = orchestrator.find('`;\n', start)
        if next_section < 0:
            raise RuntimeError("Could not bound the old Agent recovery prompt")
        orchestrator = orchestrator[:start] + orchestrator[next_section:]
        orphan_lines = ("queue_subtitle_translate", "scan_subtitle_recovery_tasks", "queue_recovered_subtitle_translate", "**Translate**", "**Subtitle Translation Recovery**", "**For translation", "Subtitle translation does not require a path", "*.fusionkit.resume.json")
        orchestrator = orchestrator.replace("tools for five file-processing operations", "tools for three file-processing operations").replace("2. **Convert**", "1. **Convert**").replace("3. **Extract**", "2. **Extract**").replace("4. **Name Translation / Rename**", "3. **Name Translation / Rename**")
        orchestrator = orchestrator.replace(" Translation custom output always opens FusionKit's fixed directory picker; never pass a path as authority.", "").replace(" If a native picker was cancelled, report that no translation task was created.", "")
        write("src/agent/orchestrator.ts", "\n".join(line for line in orchestrator.split("\n") if not any(key in line for key in orphan_lines)))
        replace("src/agent/tools.ts", 'Do not use this scan result to authorize subtitle translation; queue_subtitle_translate opens a fixed native picker.', 'Use these scan results only for conversion or language extraction.')
        # Locale namespace remains shared by Converter/Extractor and text-language selectors.
        for locale in ["en", "zh", "zh-Hant", "ja"]:
            name = f"src/locales/{locale}/subtitle.json"
            messages = json.loads(read(name))
            messages.pop("local_transcriber", None)
            # Keep translator language labels used by unrelated tools; remove dedicated UI text.
            if "translator" in messages:
                messages["translator"] = {"languages": messages["translator"]["languages"]}
            write(name, json.dumps(messages, ensure_ascii=False, indent=2) + "\n")
        config = json.loads(read("electron-builder.json"))
        config["extraResources"] = [entry for entry in config.get("extraResources", []) if entry.get("to") != "local-subtitle"]
        if config.get("beforePack") != "scripts/local-subtitle/runtime/electron-builder-local-subtitle-before-pack.cjs":
            raise RuntimeError("Unexpected legacy beforePack contribution")
        config.pop("beforePack")
        config["mac"]["signIgnore"] = [item for item in config["mac"].get("signIgnore", []) if item != "Contents/Resources/local-subtitle/"]
        write("electron-builder.json", json.dumps(config, ensure_ascii=False, indent=2) + "\n")

        source_files = []
        for directory, children, files in os.walk(destination, followlinks=False):
            children[:] = [name for name in children if name != "node_modules"]
            source_files.extend(Path(directory) / name for name in files)
        for file in source_files:
            if not file.is_file() or file.is_symlink() or file == marker:
                continue
            name = file.relative_to(destination).as_posix()
            if name in manifest["copied"]:
                after = sha(file.read_bytes())
                if after != manifest["copied"][name]:
                    manifest["modified"][name] = {"before": manifest["copied"][name], "after": after}
            else:
                manifest["created"][name] = sha(file.read_bytes())
        save_manifest()
        if options.build:
            checks = [
                ("types", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"]),
                ("build", ["node", "node_modules/vite/bin/vite.js", "build", "--mode=test"]),
                ("preload", ["node", "scripts/check-preload-bundle.mjs"]),
                ("boundaries", ["node", "scripts/subtitle-studio/check-boundaries.mjs"]),
                ("retained-tools", ["node", "node_modules/vitest/vitest.mjs", "run", "test/native-file-selection", "test/audio/audioIpcService.test.ts", "src/store/tools/subtitle/useSubtitleConverterStore.test.ts", "src/pages/Tools/_shared/ui/toolConfigDisclosureConsumers.test.ts", "src/pages/Tools/_shared/ui/toolBooleanControlConsumers.test.ts", "src/agent/tool-schemas.test.ts", "src/agent/queue-batch.test.ts"]),
            ]
            for name, command in checks:
                log = destination / f"removal-{name}.log"
                status = run(command, destination, log)
                manifest["checks"][name] = {"command": command, "exitCode": status, "log": log.name}
                save_manifest()
                print(f"{name}: exit {status}; {log}", flush=True)
                if status:
                    raise RuntimeError(f"{name} failed; inspect {log}")
        print(f"Prepared audited rehearsal: {destination}", flush=True)
    except BaseException as error:
        manifest["failure"] = str(error)
        save_manifest()
        raise


if __name__ == "__main__":
    main()
