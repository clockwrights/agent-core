// ---------------------------------------------------------------------------
// Golden-document regression set.
//
// Each JSON file in test/golden/ describes a synthetic submission and the
// segmentation, classification and fields the pipeline must produce for it,
// run deterministically (no LLM). Only keys present in a fixture's expected
// group are compared, so a fixture pins exactly what it cares about.
//
// Adding a case: drop a new <name>.json next to the others. All content must
// be synthetic — never real documents or personal data.
// ZIP inputs are built with adm-zip, which stores entries sorted by name:
// prefix file names ("1-…", "2-…") so the sorted order is the intended page order.
//
// Fixture shape:
//   {
//     "description": "...",
//     "knownIssue": "...",            // optional: runs as a todo until fixed
//     "input": { "type": "text", "fileName", "text" }
//            | { "type": "zip", "fileName", "files": [{ "name", "text" }] },
//     "request": { ...extra DocumentPipelineRequest fields },   // optional
//     "expected": { "groups": [{ "units", "method", "confidence", "label",
//                                "tier", "fields": { name: value }, "flags" }] }
//   }
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { runDocumentPipeline } from "../src/pipeline.js";
import type { AnalysisPackage, DocumentPipelineRequest } from "../src/types.js";

type GoldenInput =
  | { type: "text"; fileName: string; text: string }
  | { type: "zip"; fileName: string; files: Array<{ name: string; text: string }> };

type ExpectedGroup = {
  units?: number[];
  method?: string;
  confidence?: number;
  label?: string;
  tier?: string;
  fields?: Record<string, string>;
  flags?: string[];
};

type GoldenFixture = {
  description: string;
  knownIssue?: string;
  input: GoldenInput;
  request?: Partial<DocumentPipelineRequest>;
  expected: { groups: ExpectedGroup[] };
};

const GOLDEN_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "golden");

function buildBuffer(input: GoldenInput): Buffer {
  if (input.type === "text") return Buffer.from(input.text, "utf8");
  const zip = new AdmZip();
  for (const file of input.files) zip.addFile(file.name, Buffer.from(file.text, "utf8"));
  return zip.toBuffer();
}

/** Flatten the package into the comparable shape used by fixtures. */
function actualGroups(pkg: AnalysisPackage): Required<ExpectedGroup>[] {
  return pkg.segmentationMap.groups.map((group) => {
    const classified = pkg.classifiedGroups.find((c) => c.groupId === group.id);
    return {
      units: group.unitIndices,
      method: group.segmentationMethod,
      confidence: group.confidence,
      label: classified?.label ?? "(unclassified)",
      tier: classified?.classificationTier ?? "(none)",
      fields: Object.fromEntries((classified?.fields ?? []).map((f) => [f.name, f.value])),
      flags: classified?.uncertaintyFlags ?? [],
    };
  });
}

/** Keep only the keys the fixture specifies. */
function pick(actual: Required<ExpectedGroup>, expected: ExpectedGroup): ExpectedGroup {
  const out: ExpectedGroup = {};
  for (const key of Object.keys(expected) as (keyof ExpectedGroup)[]) {
    (out as Record<string, unknown>)[key] = actual[key];
  }
  return out;
}

const fixtureFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();

test("golden set is present", () => {
  assert.ok(fixtureFiles.length >= 5, `expected golden fixtures in ${GOLDEN_DIR}`);
});

for (const file of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf8")) as GoldenFixture;
  const name = `golden: ${file.replace(/\.json$/, "")} — ${fixture.description}`;

  test(name, { todo: fixture.knownIssue }, async () => {
    const result = await runDocumentPipeline({
      buffer: buildBuffer(fixture.input),
      fileName: fixture.input.fileName,
      executionMode: "deterministic-first",
      ...fixture.request,
    });
    const pkg = result.analysisPackage;

    const failedStages = pkg.processingLog.filter((e) => e.status === "failed").map((e) => `${e.stage}: ${e.detail}`);
    assert.deepEqual(failedStages, [], "no pipeline stage may fail");

    const actual = actualGroups(pkg);
    assert.equal(
      actual.length,
      fixture.expected.groups.length,
      `group count — actual groups: ${JSON.stringify(actual.map((g) => g.units))}`,
    );
    fixture.expected.groups.forEach((expected, i) => {
      assert.deepEqual(pick(actual[i]!, expected), expected, `group ${i + 1}`);
    });
  });
}
