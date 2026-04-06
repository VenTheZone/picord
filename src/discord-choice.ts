export interface DiscordChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface DiscordChoicePrompt {
  title: string;
  submitPrompt?: string;
  options: DiscordChoiceOption[];
}

function sanitizeValue(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

function normalizeOption(option: Partial<DiscordChoiceOption>): DiscordChoiceOption | undefined {
  const label = option.label?.trim();
  if (!label) return undefined;
  const value = (option.value?.trim() || sanitizeValue(label)).slice(0, 100);
  if (!value) return undefined;
  return {
    value,
    label: label.slice(0, 100),
    description: option.description?.trim()?.slice(0, 100),
  };
}

export function parseStructuredDiscordChoice(text: string): DiscordChoicePrompt | undefined {
  const match = text.match(/<discord-choice(?:\s+title="([^"]+)")?(?:\s+submit="([^"]+)")?\s*>\n([\s\S]*?)\n<\/discord-choice>/i);
  if (!match) return undefined;

  const title = match[1]?.trim() || "Choose an option";
  const submitPrompt = match[2]?.trim() || undefined;
  const body = match[3] ?? "";
  const blocks = body.split(/\n(?=-\s*value:)/g).map((entry) => entry.trim()).filter(Boolean);
  const options: DiscordChoiceOption[] = [];

  for (const block of blocks) {
    const value = block.match(/-\s*value:\s*(.+)/i)?.[1]?.trim();
    const label = block.match(/label:\s*(.+)/i)?.[1]?.trim();
    const description = block.match(/description:\s*(.+)/i)?.[1]?.trim();
    const option = normalizeOption({ value, label, description });
    if (option) options.push(option);
  }

  if (options.length < 2 || options.length > 5) return undefined;
  return { title: title.slice(0, 100), submitPrompt, options };
}

export function parseHeuristicDiscordChoice(text: string): DiscordChoicePrompt | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = lines
    .map((line) => line.match(/^(?:option\s+)?([1-5A-E])[).:-]\s+(.+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match));

  if (numbered.length < 2 || numbered.length > 5) return undefined;

  const options = numbered.map((match) => normalizeOption({
    value: match[1],
    label: match[2],
  })).filter((option): option is DiscordChoiceOption => Boolean(option));

  if (options.length < 2 || options.length > 5) return undefined;
  return {
    title: "Choose an option",
    options,
  };
}

export function extractDiscordChoicePrompt(text: string): DiscordChoicePrompt | undefined {
  return parseStructuredDiscordChoice(text) ?? parseHeuristicDiscordChoice(text);
}
