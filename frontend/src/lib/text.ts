/**
 * House style for text we show, including AI-written suggestions: no em or
 * en dashes and no emoji. Applied at display time; stored text is unchanged.
 */
export function plainText(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '')
    .replace(/,?\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
