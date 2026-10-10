type MarkdownCodeBlock = {
  info: string;
  content: string;
};

function readFencedLineMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenceCharacter === undefined) {
      const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (openingFence === null) continue;
      fenceCharacter = openingFence[1][0] as "`" | "~";
      fenceLength = openingFence[1].length;
      mask[index] = true;
      continue;
    }

    mask[index] = true;
    const closingFence = line.match(/^ {0,3}(`+|~+)\s*$/)?.[1];
    if (
      closingFence !== undefined &&
      closingFence[0] === fenceCharacter &&
      closingFence.length >= fenceLength
    ) {
      fenceCharacter = undefined;
      fenceLength = 0;
    }
  }

  return mask;
}

export function readMarkdownSection(document: string, headingPattern: RegExp): string {
  const lines = document.split("\n");
  const fencedLines = readFencedLineMask(lines);
  const pattern = new RegExp(headingPattern.source, headingPattern.flags.replace(/[gy]/g, ""));
  const headingIndex = lines.findIndex((line, index) => {
    if (fencedLines[index]) return false;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    return match !== null && pattern.test(match[2]);
  });

  if (headingIndex === -1) {
    throw new Error(`Markdown section heading not found: ${headingPattern}`);
  }

  const headingLevel = lines[headingIndex].match(/^#+/)?.[0].length;
  if (headingLevel === undefined) throw new Error("Markdown section heading level not found");

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (fencedLines[index]) continue;
    const nextHeadingLevel = lines[index].match(/^(#{1,6})\s+/)?.[1].length;
    if (nextHeadingLevel !== undefined && nextHeadingLevel <= headingLevel) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(headingIndex + 1, endIndex).join("\n");
}

export function readMarkdownParagraphs(document: string): string[] {
  const lines = document.split("\n");
  const fencedLines = readFencedLineMask(lines);
  return lines
    .map((line, index) => (fencedLines[index] ? "" : line))
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function readMarkdownParagraphContaining(document: string, ...concepts: string[]): string {
  const paragraph = readMarkdownParagraphs(document).find((candidate) =>
    concepts.every((concept) => candidate.includes(concept)),
  );
  if (paragraph === undefined) {
    throw new Error(`Paragraph not found for concepts: ${concepts.join(", ")}`);
  }
  return paragraph;
}

export function readFencedCodeBlocks(document: string): MarkdownCodeBlock[] {
  const lines = document.split("\n");
  const blocks: MarkdownCodeBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const openingFence = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*$/);
    if (openingFence === null) continue;

    const fenceCharacter = openingFence[1][0];
    const fenceLength = openingFence[1].length;
    const content: string[] = [];
    index += 1;
    while (index < lines.length) {
      const closingFence = lines[index].match(/^ {0,3}(`+|~+)\s*$/)?.[1];
      if (
        closingFence !== undefined &&
        closingFence[0] === fenceCharacter &&
        closingFence.length >= fenceLength
      ) {
        break;
      }
      content.push(lines[index]);
      index += 1;
    }
    blocks.push({ info: openingFence[2], content: content.join("\n") });
  }

  return blocks;
}

export function hasMarkdownLinkTo(document: string, destination: string): boolean {
  const prose = readMarkdownParagraphs(document).join("\n");
  return Array.from(prose.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)).some(
    (match) => match[1] === destination,
  );
}
