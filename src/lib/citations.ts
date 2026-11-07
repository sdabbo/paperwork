// The Ask view's answers cite the documents they were given as [1], [2]… (server/ask.ts). Only the ones an
// answer cites are its sources: the others were read but didn't help. Those cited are numbered anew in the order
// the answer first cites them, so an answer citing [1] and [4] shows sources 1 and 2.

// [3], and lists such as [1, 3] or [1; 3]
const CITATION = /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g;

export interface Cited<T> {
  // The answer's markdown, each citation a link to #source-<number given to the AI> showing the new number
  markdown: string;
  // The documents cited, in their new order
  sources: T[];
}

export function citedSources<T>(text: string, given: T[]): Cited<T> {
  // The numbers given to the AI, in the order first cited
  const order: number[] = [];
  const markdown = text.replace(CITATION, (match, list: string) => {
    const numbers = list.split(/[,;]/).map(n => Number(n.trim()));
    // Not a citation of the documents given, e.g. a year in brackets
    if (!numbers.every(n => given[n - 1] !== undefined)) return match;
    return numbers
      .map(n => {
        if (!order.includes(n)) order.push(n);
        return `[${order.indexOf(n) + 1}](#source-${n})`;
      })
      .join('');
  });
  return { markdown, sources: order.map(n => given[n - 1]) };
}
