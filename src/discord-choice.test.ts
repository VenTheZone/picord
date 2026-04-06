import { describe, expect, it } from "vitest";
import { extractDiscordChoicePrompt, parseHeuristicDiscordChoice, parseStructuredDiscordChoice } from "./discord-choice.js";

describe("discord-choice parsing", () => {
  it("parses structured discord choice blocks", () => {
    const parsed = parseStructuredDiscordChoice(`
<discord-choice title="Pick an approach" submit="Use this selection as my answer">
- value: recommended
  label: Recommended
  description: Best balance of safety and speed
- value: simple
  label: Simple
  description: Lowest implementation complexity
</discord-choice>
`.trim());

    expect(parsed).toEqual({
      title: "Pick an approach",
      submitPrompt: "Use this selection as my answer",
      options: [
        {
          value: "recommended",
          label: "Recommended",
          description: "Best balance of safety and speed",
        },
        {
          value: "simple",
          label: "Simple",
          description: "Lowest implementation complexity",
        },
      ],
    });
  });

  it("parses heuristic numbered choices", () => {
    const parsed = parseHeuristicDiscordChoice(`
1. Recommended
2. Fastest
3. Safest
`.trim());

    expect(parsed?.title).toBe("Choose an option");
    expect(parsed?.options.map((option) => option.label)).toEqual(["Recommended", "Fastest", "Safest"]);
  });

  it("prefers structured parsing over heuristic parsing", () => {
    const parsed = extractDiscordChoicePrompt(`
<discord-choice title="Pick one">
- value: recommended
  label: Recommended
- value: fastest
  label: Fastest
</discord-choice>

1. Ignore this
2. Ignore that
`.trim());

    expect(parsed?.title).toBe("Pick one");
    expect(parsed?.options.map((option) => option.label)).toEqual(["Recommended", "Fastest"]);
  });
});
