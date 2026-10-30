import { expect, it } from "vitest";
import { exportFrameWeb } from "../src/web-export";
import { styleVariable } from "../src/web-style-variables";
import { designSystemFixture } from "./web-design-system-fixture";

it("exports scoped theme variables, aliases and reusable component templates without changing authoring", () => {
  const doc = designSystemFixture(),
    before = JSON.stringify(doc);
  const result = exportFrameWeb(doc, "frame");
  expect(JSON.stringify(doc)).toBe(before);
  expect(result.html).toContain('data-dr-theme="dark"');
  expect(result.html).toContain('data-dr-theme-set=""');
  expect(result.html.match(/<template /g)).toHaveLength(6);
  expect(result.css).toContain(
    `${styleVariable("token", "alias")}:var(${styleVariable("token", "primary")})`,
  );
  expect(result.css).toContain(
    `background-image:linear-gradient(var(${styleVariable("style", "surface")})`,
  );
  expect(result.css).toContain(`${styleVariable("token", "fx")}:none`);
  expect(result.css).not.toContain("undefined");
});
it("keeps adversarial IDs distinct across typography suffixes and namespaces", () => {
  expect(styleVariable("token", "a--font-size")).not.toBe(
    styleVariable("token", "a", "font-size"),
  );
  expect(styleVariable("style", "a")).not.toBe(styleVariable("token", "a"));
});
